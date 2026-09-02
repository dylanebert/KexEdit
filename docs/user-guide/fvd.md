# Force Vector Design

Design the ride from the rider's seat. In Force Vector Design, you set the forces riders should feel, then KexEdit turns those forces into track.

## Think in Forces

Start with the feeling you want riders to notice: a pull into a hill, the lightness of airtime, or pressure through a turn. Force Vector Design lets you shape those feelings directly.

A Force Section carries that rider experience over time. Its timeline controls the forces acting on the rider:

- **Normal force** controls the feeling of being pushed into or lifted from the seat.
- **Lateral force** controls side-to-side pressure.
- **Roll speed** controls how quickly the track rotates around the rider.

Change a value at a keyframe, and KexEdit generates the track shape needed to produce that force. You can shape a complete element by placing several keyframes along the section timeline.

## Create a Hill With Airtime

1. Add a **Force Section** to your track.
2. Add a normal-force keyframe where the hill begins. Raise the value to create a strong pull into the climb.
3. Add a second keyframe near the crest and bring normal force toward `0G`.
4. Play the section in Game View and press `R` to toggle the ride camera. The first keyframe creates the pull-up; the second creates the floating feeling of airtime.

Use the same approach for other rider experiences. Add lateral force for a turn that presses riders sideways. Change roll speed to shape how the track banks around them.

---

[← Back to Documentation](../)
