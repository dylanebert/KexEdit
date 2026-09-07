# Fidelity

The modeling law for every simulation decision in this repo: KexEdit is a coaster game, not CAD software.

**The boundary: anything that touches rider forces or track shape must be physically accurate and grounded in proven references.** Speed profiles, friction and drag, multi-car train dynamics, and heartline kinematics all sit inside it. Everything past it — wheel and bogie internals, suspension compliance, material wear — is gamified or cosmetic: collapse those dynamics into the simplest representation that keeps the inside-boundary quantities right (wheel materials become a per-track Coulomb μ on the actual normal force, not a wheel model). The substrate under a real coaster does include every wheel and bearing; the concession is deliberate and lives exactly at this line.

**Authoring ethos** (the Tiny Glade register): making an amazing coaster is easy and intuitive by default, depth is progressively disclosed, and an advanced user can step in and specify any coaster precisely. Realism serves rider experience and track shaping, never simulation for its own sake.

**Verification standard, inside the boundary: independent models converging.** Grounding in proven references is the first step for anything new. The authority for correctness is agreement between independent models — closed-form analytics where they exist, an independent high-order integrator of the continuous ODE, and the shipping kernel — with convergence order asserted, not a single-point match. A prior implementation (including this repo's own older cores) is a cross-check where the models provably coincide, never the authority: match physics, not previous versions.
