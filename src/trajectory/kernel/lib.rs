//! The march and resample kernels, pure over shared memory: the wasm-simd128 twins of
//! `integrator.ts` `step`/`march` and `resample.ts` `resample`, in f64 with f32 storage.
//!
//! Nothing here allocates or owns layout. `execution.ts` lays every region out above `__heap_base` once,
//! before any worker wakes, and hands the kernels pointers; the tick and pose lanes arrive through
//! `setLayout` from the typegpu schemas, so no stride is authored twice. The f64 boundary stream is
//! this module's own format: `BOUNDARY_FLOATS` per chunk, position, rotation, speed, distance.
//!
//! Threads. Shallot's pool (`createPool`) boots each worker against this module and calls
//! `workerMain(index)`, index 0 being the calling thread. A resample job is a fixed pose-chunk grid
//! striped by chunk index modulo the thread count: every chunk costs the same, so the stripes balance
//! with no claim counter, and every pose reads only the trajectory and writes only its own bytes, so
//! the output is the same bytes on any thread count. Nothing spins, so `workerFault` has nothing to
//! release.

#![no_std]

use core::ptr::addr_of_mut;
use libm::{acos, cos, sin, sqrt};

#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}

pub const BOUNDARY_FLOATS: usize = 9;
const INPUT_FLOATS: usize = 4;

#[derive(Clone, Copy)]
struct Layout {
    tick_floats: usize,
    position: usize,
    rotation: usize,
    speed: usize,
    distance: usize,
    omega: usize,
    a: usize,
    pose_floats: usize,
    pose_position: usize,
    pose_w: usize,
    pose_rotation: usize,
}

static mut LAYOUT: Layout = Layout {
    tick_floats: 0,
    position: 0,
    rotation: 0,
    speed: 0,
    distance: 0,
    omega: 0,
    a: 0,
    pose_floats: 0,
    pose_position: 0,
    pose_w: 0,
    pose_rotation: 0,
};

#[derive(Clone, Copy)]
struct Job {
    ticks: *const f32,
    sigma: *const f64,
    spans: *const u32,
    span_count: usize,
    poses: *mut f32,
    spacing: f64,
    length: f64,
    pose_count: usize,
    chunk: usize,
    threads: usize,
}

static mut JOB: Job = Job {
    ticks: core::ptr::null(),
    sigma: core::ptr::null(),
    spans: core::ptr::null(),
    span_count: 0,
    poses: core::ptr::null_mut(),
    spacing: 0.0,
    length: 0.0,
    pose_count: 0,
    chunk: 1,
    threads: 1,
};

fn layout() -> Layout {
    unsafe { LAYOUT }
}

#[no_mangle]
pub extern "C" fn setLayout(
    tick_floats: u32,
    position: u32,
    rotation: u32,
    speed: u32,
    distance: u32,
    omega: u32,
    a: u32,
    pose_floats: u32,
    pose_position: u32,
    pose_w: u32,
    pose_rotation: u32,
) {
    unsafe {
        *addr_of_mut!(LAYOUT) = Layout {
            tick_floats: tick_floats as usize,
            position: position as usize,
            rotation: rotation as usize,
            speed: speed as usize,
            distance: distance as usize,
            omega: omega as usize,
            a: a as usize,
            pose_floats: pose_floats as usize,
            pose_position: pose_position as usize,
            pose_w: pose_w as usize,
            pose_rotation: pose_rotation as usize,
        };
    }
}

#[no_mangle]
pub extern "C" fn boundaryFloats() -> u32 {
    BOUNDARY_FLOATS as u32
}

/// The pool's boot probe calls this once per worker; there is no per-thread scratch.
#[no_mangle]
pub extern "C" fn scratchPtr() -> u32 {
    0
}

#[no_mangle]
pub extern "C" fn workerFault() {}

type Vec3 = [f64; 3];
type Quat = [f64; 4];

#[derive(Clone, Copy)]
struct State {
    position: Vec3,
    rotation: Quat,
    speed: f64,
    distance: f64,
}

const FORWARD: Vec3 = [0.0, 0.0, -1.0];

fn multiply(p: Quat, q: Quat) -> Quat {
    [
        p[3] * q[0] + p[0] * q[3] + p[1] * q[2] - p[2] * q[1],
        p[3] * q[1] - p[0] * q[2] + p[1] * q[3] + p[2] * q[0],
        p[3] * q[2] + p[0] * q[1] - p[1] * q[0] + p[2] * q[3],
        p[3] * q[3] - p[0] * q[0] - p[1] * q[1] - p[2] * q[2],
    ]
}

fn rotate(q: Quat, v: Vec3) -> Vec3 {
    let [x, y, z, w] = q;
    let tx = 2.0 * (y * v[2] - z * v[1]);
    let ty = 2.0 * (z * v[0] - x * v[2]);
    let tz = 2.0 * (x * v[1] - y * v[0]);
    [
        v[0] + w * tx + (y * tz - z * ty),
        v[1] + w * ty + (z * tx - x * tz),
        v[2] + w * tz + (x * ty - y * tx),
    ]
}

fn sinc(x: f64) -> f64 {
    if x.abs() < 1e-4 {
        1.0 - (x * x) / 6.0
    } else {
        sin(x) / x
    }
}

fn exp_map(r: Vec3) -> Quat {
    let half = 0.5 * sqrt(r[0] * r[0] + r[1] * r[1] + r[2] * r[2]);
    let k = 0.5 * sinc(half);
    [r[0] * k, r[1] * k, r[2] * k, cos(half)]
}

/// `integrator.ts` `step`: exponential map in rotation, exact chord in position.
fn step(state: &State, omega: Vec3, a: f64, dt: f64) -> State {
    let body = [omega[0], omega[1], -omega[2]];
    let r = [body[0] * dt, body[1] * dt, body[2] * dt];
    let theta = sqrt(r[0] * r[0] + r[1] * r[1] + r[2] * r[2]);
    let half_turn = rotate(exp_map([r[0] / 2.0, r[1] / 2.0, r[2] / 2.0]), FORWARD);
    let mut chord = half_turn;
    if theta > 0.0 {
        let n = [r[0] / theta, r[1] / theta, r[2] / theta];
        let along = n[0] * FORWARD[0] + n[1] * FORWARD[1] + n[2] * FORWARD[2];
        let k = sinc(theta / 2.0);
        for c in 0..3 {
            chord[c] = along * n[c] + k * (half_turn[c] - along * n[c]);
        }
    }
    let travel = (state.speed + 0.5 * a * dt) * dt;
    let world = rotate(state.rotation, chord);
    let q = multiply(state.rotation, exp_map(r));
    let norm = sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]);
    State {
        position: [
            state.position[0] + world[0] * travel,
            state.position[1] + world[1] * travel,
            state.position[2] + world[2] * travel,
        ],
        rotation: [q[0] / norm, q[1] / norm, q[2] / norm, q[3] / norm],
        speed: state.speed + a * dt,
        distance: state.distance + travel,
    }
}

unsafe fn load_boundary(bounds: *const f64, chunk: usize) -> State {
    let b = bounds.add(chunk * BOUNDARY_FLOATS);
    State {
        position: [*b, *b.add(1), *b.add(2)],
        rotation: [*b.add(3), *b.add(4), *b.add(5), *b.add(6)],
        speed: *b.add(7),
        distance: *b.add(8),
    }
}

unsafe fn store_boundary(bounds: *mut f64, chunk: usize, s: &State) {
    let b = bounds.add(chunk * BOUNDARY_FLOATS);
    let values = [
        s.position[0], s.position[1], s.position[2], s.rotation[0], s.rotation[1], s.rotation[2], s.rotation[3],
        s.speed, s.distance,
    ];
    for (i, v) in values.iter().enumerate() {
        *b.add(i) = *v;
    }
}

unsafe fn write_tick(ticks: *mut f32, l: &Layout, t: usize, s: &State, omega: Vec3, a: f64) {
    let o = ticks.add(t * l.tick_floats);
    for c in 0..3 {
        *o.add(l.position + c) = s.position[c] as f32;
        *o.add(l.omega + c) = omega[c] as f32;
    }
    for c in 0..4 {
        *o.add(l.rotation + c) = s.rotation[c] as f32;
    }
    *o.add(l.speed) = s.speed as f32;
    *o.add(l.distance) = s.distance as f32;
    *o.add(l.a) = a as f32;
}

/// March ticks `[from_chunk * chunk, count)` from the f64 state stored at boundary `from_chunk`.
/// `inputs` holds `count - 1` rows of (ω pitch, yaw, roll, a); tick `t + 1` is the state after row `t`
/// and carries it, tick 0 carries row 0. Every tick on the grid stores its f64 state as that chunk's
/// boundary, so a later restart from any of them reproduces this march byte for byte.
#[no_mangle]
pub unsafe extern "C" fn march(
    inputs: *const f64,
    ticks: *mut f32,
    bounds: *mut f64,
    from_chunk: u32,
    count: u32,
    dt: f64,
    chunk: u32,
) {
    let l = layout();
    let (count, chunk) = (count as usize, chunk as usize);
    let start = from_chunk as usize * chunk;
    let row = |t: usize| {
        let r = inputs.add(t * INPUT_FLOATS);
        ([*r, *r.add(1), *r.add(2)], *r.add(3))
    };
    let mut state = load_boundary(bounds, from_chunk as usize);
    for t in start..count {
        if t > start {
            let (omega, a) = row(t - 1);
            state = step(&state, omega, a, dt);
            if t % chunk == 0 {
                store_boundary(bounds, t / chunk, &state);
            }
        }
        let (omega, a) = row(if t == 0 { 0 } else { t - 1 });
        write_tick(ticks, &l, t, &state, omega, a);
    }
}

/// The sequential resample prepass: running arclength `sigma[i]` as the sum of |Δdistance| over the f32
/// distance lane, and the start tick of every interval with non-zero arclength into `spans`. Returns the
/// span count; `sigma[count - 1]` is the length.
#[no_mangle]
pub unsafe extern "C" fn resamplePrepare(ticks: *const f32, count: u32, sigma: *mut f64, spans: *mut u32) -> u32 {
    let l = layout();
    let distance = |i: usize| *ticks.add(i * l.tick_floats + l.distance) as f64;
    let mut n = 0usize;
    *sigma = 0.0;
    for i in 1..count as usize {
        let ds = (distance(i) - distance(i - 1)).abs();
        *sigma.add(i) = *sigma.add(i - 1) + ds;
        if ds > 0.0 {
            *spans.add(n) = (i - 1) as u32;
            n += 1;
        }
    }
    n as u32
}

fn slerp(p: Quat, q: Quat, u: f64) -> Quat {
    let mut dot = p[0] * q[0] + p[1] * q[1] + p[2] * q[2] + p[3] * q[3];
    let sign = if dot < 0.0 { -1.0 } else { 1.0 };
    dot *= sign;
    let mut a = 1.0 - u;
    let mut b = u * sign;
    if dot < 1.0 - 1e-9 {
        let theta = acos(dot);
        let s = sin(theta);
        a = sin((1.0 - u) * theta) / s;
        b = (sin(u * theta) / s) * sign;
    }
    let r = [a * p[0] + b * q[0], a * p[1] + b * q[1], a * p[2] + b * q[2], a * p[3] + b * q[3]];
    let norm = sqrt(r[0] * r[0] + r[1] * r[1] + r[2] * r[2] + r[3] * r[3]);
    [r[0] / norm, r[1] / norm, r[2] / norm, r[3] / norm]
}

/// Resample poses `[start, end)` of the job: `resample.ts` pose by pose, with the walk's span found by
/// binary search at `start` so any range runs alone.
unsafe fn resample_range(job: &Job, start: usize, end: usize) {
    let l = layout();
    let tf = l.tick_floats;
    let vec3 = |i: usize, lane: usize| {
        let o = job.ticks.add(i * tf + lane);
        [*o as f64, *o.add(1) as f64, *o.add(2) as f64]
    };
    let quat = |i: usize| {
        let o = job.ticks.add(i * tf + l.rotation);
        [*o as f64, *o.add(1) as f64, *o.add(2) as f64, *o.add(3) as f64]
    };
    let distance = |i: usize| *job.ticks.add(i * tf + l.distance) as f64;
    let span = |k: usize| *job.spans.add(k) as usize;
    let end_sigma = |k: usize| *job.sigma.add(span(k) + 1);
    let write = |i: usize, p: Vec3, q: Quat| {
        let o = job.poses.add(i * l.pose_floats);
        for c in 0..3 {
            *o.add(l.pose_position + c) = p[c] as f32;
        }
        *o.add(l.pose_w) = 0.0;
        for c in 0..4 {
            *o.add(l.pose_rotation + c) = q[c] as f32;
        }
    };
    if start >= end {
        return;
    }
    if job.span_count == 0 {
        for i in start..end {
            write(i, vec3(0, l.position), quat(0));
        }
        return;
    }
    let last = job.span_count - 1;
    let first_s = (start as f64 * job.spacing).min(job.length);
    // the first k in [0, last) whose interval ends at or past s, else last: where the linear walk stops
    let (mut lo, mut hi) = (0usize, last);
    while lo < hi {
        let mid = (lo + hi) / 2;
        if end_sigma(mid) < first_s {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    let mut k = lo;
    for i in start..end {
        let s = (i as f64 * job.spacing).min(job.length);
        while k < last && end_sigma(k) < s {
            k += 1;
        }
        let j = span(k);
        let s0 = *job.sigma.add(j);
        let h = *job.sigma.add(j + 1) - s0;
        let u = ((s - s0) / h).max(0.0).min(1.0);
        let dd = distance(j + 1) - distance(j);
        let direction = (if dd > 0.0 { 1.0 } else if dd < 0.0 { -1.0 } else { 0.0 }) * h;
        let q0 = quat(j);
        let q1 = quat(j + 1);
        let p0 = vec3(j, l.position);
        let p1 = vec3(j + 1, l.position);
        let m0 = rotate(q0, FORWARD);
        let m1 = rotate(q1, FORWARD);
        let u2 = u * u;
        let u3 = u2 * u;
        let h00 = 2.0 * u3 - 3.0 * u2 + 1.0;
        let h10 = (u3 - 2.0 * u2 + u) * direction;
        let h01 = -2.0 * u3 + 3.0 * u2;
        let h11 = (u3 - u2) * direction;
        let mut p = [0.0; 3];
        for c in 0..3 {
            p[c] = h00 * p0[c] + h10 * m0[c] + h01 * p1[c] + h11 * m1[c];
        }
        write(i, p, slerp(q0, q1, u));
    }
}

/// Stage a resample job for `workerMain`. Runs on the calling thread before the pool wakes.
#[no_mangle]
pub unsafe extern "C" fn setResampleJob(
    ticks: *const f32,
    sigma: *const f64,
    spans: *const u32,
    span_count: u32,
    poses: *mut f32,
    spacing: f64,
    length: f64,
    pose_count: u32,
    chunk: u32,
    threads: u32,
) {
    *addr_of_mut!(JOB) = Job {
        ticks,
        sigma,
        spans,
        span_count: span_count as usize,
        poses,
        spacing,
        length,
        pose_count: pose_count as usize,
        chunk: chunk as usize,
        threads: threads as usize,
    };
}

/// Resample poses `[start, end)` of the staged job on the calling thread.
#[no_mangle]
pub unsafe extern "C" fn resampleRange(start: u32, end: u32) {
    let job = JOB;
    resample_range(&job, start as usize, (end as usize).min(job.pose_count));
}

/// One thread's stripe of the staged job: every pose chunk whose index is `worker` modulo the threads.
#[no_mangle]
pub unsafe extern "C" fn workerMain(worker: u32) {
    let job = JOB;
    let chunks = job.pose_count.div_ceil(job.chunk);
    let mut c = worker as usize;
    while c < chunks {
        let start = c * job.chunk;
        resample_range(&job, start, (start + job.chunk).min(job.pose_count));
        c += job.threads;
    }
}
