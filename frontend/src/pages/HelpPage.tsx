import { AppHeader } from "../components/AppHeader";

export function HelpPage() {
  return (
    <main className="home-page">
      <AppHeader />
      <section className="card">
        <h1>Help</h1>
        <p className="muted">How to run a race, how matchups are generated, and how rankings are calculated.</p>
      </section>

      <section className="card">
        <h2>Quick Start</h2>
        <ol style={{ margin: 0, paddingLeft: "1.25rem", display: "grid", gap: "0.5rem" }}>
          <li>Create an event (guest or signed-in).</li>
          <li>Configure lanes, elimination points, and theme (System uses your device light/dark).</li>
          <li>Add racers (name + car number).</li>
          <li>Open the Kiosk on the display device.</li>
          <li>Link an operator device by scanning the QR and entering the pairing code.</li>
          <li>Generate the next heat, then submit the full finish order after each race.</li>
        </ol>
      </section>

      <section className="card">
        <h2>Operator Controls</h2>
        <ul style={{ margin: 0, paddingLeft: "1.25rem", display: "grid", gap: "0.5rem" }}>
          <li>Generate Heat creates the next matchup (minimum 2 active racers).</li>
          <li>Submit Result records the finish order and updates points + eliminations.</li>
          <li>When only one active racer remains, the event is complete and the kiosk switches to Final Standings.</li>
        </ul>
      </section>

      <section className="card">
        <h2>How Matchups Are Made</h2>
        <ul style={{ margin: 0, paddingLeft: "1.25rem", display: "grid", gap: "0.5rem" }}>
          <li>The system only generates heats when there are at least 2 non-eliminated racers available.</li>
          <li>Primary goal: keep “heats raced” balanced so nobody races twice before everyone has raced once (where possible).</li>
          <li>It prefers matchups where racers face new opponents (avoiding repeat pairings when possible).</li>
          <li>It also tries to keep lane assignments fair over time.</li>
          <li>If it cannot generate a valid heat with the remaining racers, it will refuse rather than create a single-car heat.</li>
        </ul>
        <details style={{ marginTop: "0.5rem" }}>
          <summary>Matchmaking details (expand)</summary>
          <div style={{ display: "grid", gap: "0.75rem", marginTop: "0.75rem" }}>
            <div>
              <div style={{ fontWeight: 800 }}>1) Heat participation balance (highest priority)</div>
              <ul style={{ margin: "0.35rem 0 0", paddingLeft: "1.25rem", display: "grid", gap: "0.35rem" }}>
                <li>Each racer tracks how many heats they’ve run so far.</li>
                <li>The next heat is built primarily from racers with the lowest heat count, so everyone gets a turn before anyone repeats (when possible).</li>
                <li>This can intentionally create heats with empty lanes to keep participation fair.</li>
                <li>Example: with 6 racers on a 4-lane track, it will prefer two 3-racer heats (3 + 3) rather than a 4 + 2 that forces repeats sooner.</li>
              </ul>
            </div>
            <div>
              <div style={{ fontWeight: 800 }}>2) Opponent variety (next priority)</div>
              <ul style={{ margin: "0.35rem 0 0", paddingLeft: "1.25rem", display: "grid", gap: "0.35rem" }}>
                <li>After participation is balanced, it prefers heats where racers haven’t faced each other yet.</li>
                <li>It tries to avoid repeating the same pairings until necessary.</li>
              </ul>
            </div>
            <div>
              <div style={{ fontWeight: 800 }}>3) Lane fairness</div>
              <ul style={{ margin: "0.35rem 0 0", paddingLeft: "1.25rem", display: "grid", gap: "0.35rem" }}>
                <li>Within the chosen group, it assigns lanes to reduce how often each racer repeats the same lane.</li>
              </ul>
            </div>
            <div>
              <div style={{ fontWeight: 800 }}>4) Competitiveness (points)</div>
              <ul style={{ margin: "0.35rem 0 0", paddingLeft: "1.25rem", display: "grid", gap: "0.35rem" }}>
                <li>As a final tie-breaker, it prefers racers with closer points to keep heats competitive.</li>
              </ul>
            </div>
            <div>
              <div style={{ fontWeight: 800 }}>What it will never do</div>
              <ul style={{ margin: "0.35rem 0 0", paddingLeft: "1.25rem", display: "grid", gap: "0.35rem" }}>
                <li>It won’t generate a heat with fewer than 2 active racers.</li>
              </ul>
            </div>
          </div>
        </details>
      </section>

      <section className="card">
        <h2>Rankings & Elimination</h2>
        <ul style={{ margin: 0, paddingLeft: "1.25rem", display: "grid", gap: "0.5rem" }}>
          <li>Each heat awards points by finish position: 1st = 0 points, 2nd = 1 point, 3rd = 2 points, etc.</li>
          <li>Total points accumulate across heats.</li>
          <li>A racer is eliminated when points are greater than or equal to the event point limit.</li>
          <li>Standings sort by: not eliminated first.</li>
          <li>Eliminated racers are ranked by who survived longer (eliminated later ranks higher), then lowest points, then name.</li>
        </ul>
      </section>

      <section className="card">
        <h2>Accounts vs Guest</h2>
        <ul style={{ margin: 0, paddingLeft: "1.25rem", display: "grid", gap: "0.5rem" }}>
          <li>Guest is best for quick setup on a single device. Guest events are stored locally on the creating device and unclaimed guest events are deleted after 24 hours.</li>
          <li>An account is best if you want your events to appear across devices, or you want long-term storage and management.</li>
          <li>If you start as a guest and later login on that same device, locally-known guest events are moved into your account.</li>
          <li>Generate Guest Access URL allows an unauthed device to open a read-only kiosk for a claimed event. You can revoke it at any time to decommission access.</li>
        </ul>
      </section>

      <section className="card">
        <h2>Inspiration</h2>
        <p className="muted">
          This project is heavily inspired by the Derby Day! race management software and its ladderless elimination approach.
          If you are on Windows and want a dedicated desktop app, Derby Day! is a great alternative.
        </p>
        <p style={{ marginTop: "0.75rem" }}>
          <a href="https://derbydaysoftware.com/" target="_blank" rel="noopener noreferrer" className="direct-link">
            Derby Day! (alternative)
          </a>
        </p>
        <p className="muted" style={{ marginTop: "0.75rem" }}>
          Derby Day! is Windows-only (.NET), as a Mac and Linux user I wanted an easy to use cross platform alternative.
        </p>
      </section>

      <section className="card">
        <h2>Created By</h2>
        <p>Plover</p>
        <p className="muted">
          Cub Scout Leader at the Strathalbyn Scout Group
        </p>
      </section>
    </main>
  );
}
