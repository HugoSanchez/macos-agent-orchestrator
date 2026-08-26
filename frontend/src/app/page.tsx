import styles from './page.module.css';

export default function HomePage() {
  return (
    <div className={styles.shell}>
      <header className={styles.siteHeader}>
        <a className={styles.logo} href="/" aria-label="Verso home">
          verso.
        </a>
      </header>

      <main className={styles.main}>
        <div className={styles.heroText}>
          <a className={styles.pill} href="#">
            <span>Experimental build</span>
          </a>

          <h1 className={styles.heading}>
            A personal <br /> second brain <br />{' '}
            <span className={styles.stress}>that gets sh*t done.</span>
          </h1>

          <p className={styles.subtitle}>
            Verso is the easiest way to run local Hermes agents that connect to
            the apps you already use — email, calendar, slack, you name it — to
            help you do more. Try for free, only for friends and family.
          </p>

          <div className={styles.actions}>
            <a
              className={styles.btnPrimary}
              href="https://github.com/HugoSanchez/macos-agent-orchestrator/releases/download/v1.0.9/verso-1.0.9.dmg"
              download
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.6}
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M8 2 L8 11" />
                <path d="M4 7.5 L8 11.5 L12 7.5" />
                <path d="M3 14 L13 14" />
              </svg>
              Download for macOS
            </a>
          </div>

          <div className={styles.btnMeta} />
        </div>

        <div className={styles.screenshot}>
          {/*
            Drop the screenshot at frontend/public/assets/screenshot.png.
            Until it's there, the <img> will 404 silently and the layout will
            still render fine (just an empty bordered frame).
          */}
          <img src="/assets/screenshot.png" alt="Verso running on macOS" />
        </div>
      </main>

    </div>
  );
}
