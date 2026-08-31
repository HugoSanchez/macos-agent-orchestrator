'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import styles from './landing-page.module.css';

const sessions = [
  ['New chat', '3m', '12 messages'],
  ['Board update', '18m', '26 messages'],
  ['Weekly prep', '1h', '8 messages'],
  ['Hiring loop', '2h', '15 messages'],
  ['Personal admin', '1d', '6 messages'],
] as const;

const appConnections = [
  ['gmail', 'Gmail'],
  ['googlecalendar', 'Calendar'],
  ['googledrive', 'Drive'],
  ['granola_mcp', 'Granola'],
  ['notion', 'Notion'],
  ['slack', 'Slack'],
  ['todoist', 'Todoist'],
] as const;

const demoActivity = [
  ['slack', 'Read 32 messages in #board-q3', 'success'],
  ['gmail', 'Found 2 threads — “Board update”', 'success'],
  ['notion', 'Opened “Q3 board deck — draft”', 'info'],
  ['googlecalendar', 'Board call — Thursday, 10:00', 'info'],
] as const;

const GITHUB_URL = 'https://github.com/HugoSanchez/macos-agent-orchestrator';
const DOWNLOAD_URL = `${GITHUB_URL}/releases/download/v1.0.23/verso-1.0.23.dmg`;

// Flip on once there are real testimonials to show.
const SHOW_TESTIMONIALS = false;

const features = [
  {
    title: 'Memory that stays home.',
    desc: 'Verso keeps a working memory of what’s around you — meetings, threads, documents — in a plain database on your Mac so that it has full context of what you are working on.',
    graphic: 'memory',
  },
  {
    title: 'Connected to your work.',
    desc: 'Link the apps you already use — mail, calendar, notes, tasks, chat — or any tool that speaks MCP. Ask once, and Verso reads across them and acts: drafts the reply, updates the doc, files the task.',
    graphic: 'apps',
  },
  {
    title: 'The best models, one place.',
    desc: 'Frontier models from OpenAI and Anthropic, switchable mid-conversation without losing context. Sign in with the accounts you already have.',
    graphic: 'models',
  },
] as const;

export default function TriagePreviewPage() {
  const [theme, setTheme] = useState<'light' | 'dark'>('light');

  useEffect(() => {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    setTheme(prefersDark ? 'dark' : 'light');
  }, []);

  const currentYear = useMemo(() => new Date().getFullYear(), []);

  return (
    <main className={styles.page} data-theme={theme}>
      <nav className={styles.nav}>
        <div className={styles.navInner}>
          <Link href="/" className={styles.brand}>
            verso.
          </Link>
        </div>
      </nav>

      <section className={styles.hero}>
        <div className={styles.heroInner}>
          <div className={styles.heroTop}>
            <div className={styles.heroText}>
              <h1>A free, open-source, agent orchestrator that gets things done.</h1>
              <p>
                Verso is an easy and intuitive macOS app that makes it trivial for non-technical folks to leverage the frontier of AI to get things done. Free and open-source. Built on Hermes Agent.
              </p>
              <div className={styles.heroActions}>
                <a className={styles.primaryButton} href={DOWNLOAD_URL} download>
                  Download for Mac
                  <ArrowRightIcon />
                </a>
                <a
                  className={styles.ghostButton}
                  href={GITHUB_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  View on GitHub
                </a>
              </div>
            </div>

            <HeroProviderOrbit />
          </div>

          <IssueMockup />
        </div>
      </section>

      <Divider />

      <section className={styles.section}>
        <div className={styles.sectionInner}>
          <p className={styles.eyebrow}>Built for simplicity</p>
          <h2>
           Everything you need.
            <br />
           Nothing you don't.
          </h2>

          <div className={styles.featureGrid}>
            {features.map((feature) => (
              <article className={styles.feature} key={feature.title}>
                <div className={styles.featureGraphic}>
                  <FeatureGraphic kind={feature.graphic} />
                </div>
                <h3>{feature.title}</h3>
                <p>{feature.desc}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <Divider />

      <section className={`${styles.section} ${styles.sectionRoomy}`}>
        <div className={styles.sectionInner}>
          <div className={styles.split}>
            <div>
              <p className={styles.eyebrow}>How it works</p>
              <h2>A simple orchestrator.</h2>
              <h2>Built on Hermes.</h2>
              <p className={styles.prose}>
                Hermes is one of the most trusted agent
                harnesses out there; used by engineering teams, tinkerers,
                and artists at the frontier. Verso wraps it in a native MacOS app, making it trivial for non-technical audiences to get the most out of it.
              </p>
              <p className={styles.prose}>
                Oh, and both are open source.
              </p>
            </div>

            <div className={styles.splitArt}>
              <div className={styles.stack} aria-hidden="true">
                <div className={`${styles.stackLayer} ${styles.stackVerso}`}>
                  <span className={styles.stackGlyph}>v.</span>
                  <div className={styles.stackDetails}>
                    <strong>Verso</strong>
                    <em>your sources</em>
                  </div>
                  <div className={styles.sourceTokens}>
                    <img src={logoUrl('gmail')} alt="" />
                    <img src={logoUrl('slack')} alt="" />
                    <img src={logoUrl('notion')} alt="" />
                    <img src={logoUrl('googledrive')} alt="" />
                    <span>PDF</span>
                    <span>docs</span>
                  </div>
                </div>
                <div className={styles.stackConnector}><i /></div>
                <div className={`${styles.stackLayer} ${styles.stackHermes}`}>
                  <span className={`${styles.stackGlyph} ${styles.nousMark}`} />
                  <div>
                    <strong>Hermes</strong>
                    <em>open-source agent harness &middot; Nous Research</em>
                  </div>
                </div>
                <div className={styles.stackConnector}>
                  <i style={{ animationDelay: '1.3s' }} />
                </div>
                <div className={`${styles.stackLayer} ${styles.stackModels}`}>
                  <div className={styles.modelMarks}>
                    <img src={logoUrl('openai')} alt="" />
                    <img src={logoUrl('claude')} alt="" />
                  </div>
                  <div>
                    <strong>Frontier models</strong>
                    <em>choose the model for the job</em>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <Divider />

      <section className={`${styles.section} ${styles.sectionRoomy}`}>
        <div className={styles.sectionInner}>
          <div className={`${styles.split} ${styles.splitFlip} ${styles.localSplit}`}>
            <div>
              <p className={styles.eyebrow}>Local by default</p>
              <h2>Integrated memory system. Stored on your Mac.</h2>
              <p className={styles.prose}>
             Everything is stored on your mac locally; every conversation, every session, tool call or context you added. There is no Verso server, and no way for anyone &mdash; including the person who
                built it &mdash; to see your data. The code is public, so you don&rsquo;t have to
                take that on faith.
              </p>
              <p className={styles.prose}>
                
              </p>
            </div>

            <div className={styles.splitArt}>
              <LocalFirstGraphic />
            </div>
          </div>
        </div>
      </section>

      {SHOW_TESTIMONIALS && (
        <>
          <Divider />

          <section className={styles.quoteSection}>
            <DiagonalShade />
            <div className={styles.quoteCard}>
              <p className={styles.eyebrow}>A note from the maker</p>
              {/* TODO(hugo): personalize this note — it's a scaffold. */}
              <blockquote>
                I built Verso for my own work: I wanted an assistant that knew my context, ran on
                my machine, and used the best models available. It&rsquo;s a personal project,
                early and imperfect, and I&rsquo;m opening it up for anyone who wants the same
                thing.
              </blockquote>
              <div className={styles.person}>
                <div className={styles.avatar} aria-hidden="true">
                  H
                </div>
                <div>
                  <span>Hugo</span>
                  <span>Maker of Verso</span>
                </div>
              </div>
            </div>
          </section>
        </>
      )}

      <Divider />

      <section className={styles.cta}>
        <DiagonalShade />
        <div className={styles.ctaInner}>
          <h2>Try it out.</h2>
          <h2>It's yours.</h2>
          <p>One signed download, your own accounts, five minutes.</p>
          <a className={styles.secondaryButton} href={DOWNLOAD_URL} download>
            Download for Mac
            <ArrowRightIcon />
          </a>
        </div>
      </section>

      <footer className={styles.footer}>
        <div className={styles.footerInner}>
          <div className={styles.footerRow}>
            <div className={styles.brand}>
              verso.
            </div>
            <span>{currentYear}</span>
          </div>
        </div>
      </footer>
    </main>
  );
}

const constellationNodes = [
  { logo: 'gmail', cx: 64, cy: 56, path: 'M78 66 C140 96, 172 116, 218 140', delay: 0 },
  { logo: 'slack', cx: 44, cy: 156, path: 'M62 156 C120 156, 162 153, 218 150', delay: 0.9 },
  { logo: 'notion', cx: 84, cy: 252, path: 'M98 242 C150 212, 176 184, 218 160', delay: 1.8 },
  { logo: 'googlecalendar', cx: 416, cy: 52, path: 'M402 62 C340 94, 308 116, 262 140', delay: 0.45 },
  { logo: 'googledrive', cx: 436, cy: 158, path: 'M418 158 C360 156, 318 153, 262 150', delay: 1.35 },
  { logo: 'todoist', cx: 396, cy: 252, path: 'M382 242 C330 212, 304 184, 262 160', delay: 2.25 },
] as const;

function HeroConstellation() {
  return (
    <div className={styles.heroArt} aria-hidden="true">
      <svg viewBox="0 0 480 300" fill="none">
        {constellationNodes.map((node) => (
          <g key={node.logo}>
            <path className={styles.constellationWire} d={node.path} />
            <path
              className={styles.constellationPacket}
              d={node.path}
              style={{ animationDelay: `${node.delay}s` }}
            />
          </g>
        ))}

        <circle className={styles.constellationPulse} cx="240" cy="150" r="26" />
        <circle
          className={styles.constellationPulse}
          cx="240"
          cy="150"
          r="26"
          style={{ animationDelay: '1.35s' }}
        />

        {constellationNodes.map((node) => (
          <g
            className={styles.constellationNode}
            key={`node-${node.logo}`}
            style={{ animationDelay: `${node.delay * -1.4}s` }}
          >
            <circle cx={node.cx} cy={node.cy} r="16" />
            <image
              href={logoUrl(node.logo)}
              x={node.cx - 7}
              y={node.cy - 7}
              width="14"
              height="14"
            />
          </g>
        ))}

        <g className={styles.constellationCenter}>
          <rect x="221" y="131" width="38" height="38" rx="10" />
          <text x="240" y="156">v.</text>
          <circle className={styles.constellationStatus} cx="256" cy="134" r="3" />
        </g>
      </svg>
    </div>
  );
}

const memoryHitCells = new Set(['3-2', '7-5', '10-1', '11-6', '5-7', '12-3']);

const memoryCells = Array.from({ length: 8 }, (_, row) =>
  Array.from({ length: 13 }, (_, col) => ({
    col,
    row,
    // wave radiates from the query cell at (0, 4)
    delay: Math.hypot(col, row - 4) * 0.1 + 0.15,
    hit: memoryHitCells.has(`${col}-${row}`),
  })),
).flat();

function HeroMemoryGrid() {
  return (
    <div className={styles.heroArt} aria-hidden="true">
      <svg viewBox="0 0 480 300" fill="none">
        <circle className={styles.memoryRing} cx="124.5" cy="152.5" r="60" />
        <circle
          className={styles.memoryRing}
          cx="124.5"
          cy="152.5"
          r="60"
          style={{ animationDelay: '0.35s' }}
        />

        {memoryCells.map((cell) => (
          <rect
            className={cell.hit ? styles.memoryHit : styles.memoryCell}
            key={`${cell.col}-${cell.row}`}
            x={120 + cell.col * 26}
            y={44 + cell.row * 26}
            width="9"
            height="9"
            rx="2.5"
            style={{ animationDelay: `${cell.delay}s` }}
          />
        ))}

        <path
          className={styles.memoryAnswer}
          d="M121 262 H354"
          pathLength={1}
          style={{ animationDelay: '2.4s' }}
        />
        <path
          className={styles.memoryAnswer}
          d="M121 276 H286"
          pathLength={1}
          style={{ animationDelay: '2.75s' }}
        />
      </svg>
    </div>
  );
}

const tickerLines = [
  { text: '▸ read inbox — 3 unread', chars: 23, delay: 0.4, done: false },
  { text: '▸ search memory "board deck"', chars: 28, delay: 1.5, done: false },
  { text: '▸ check calendar friday', chars: 23, delay: 2.6, done: false },
  { text: '▸ draft reply to sarah', chars: 22, delay: 3.7, done: false },
  { text: '✓ done · 4 tools · 11s', chars: 21, delay: 5.0, done: true },
] as const;

function HeroAgentTicker() {
  return (
    <div className={styles.heroArt} aria-hidden="true">
      <svg viewBox="0 0 480 300" fill="none">
        <rect className={styles.tickerFrame} x="90" y="30" width="310" height="240" rx="10" />
        <circle className={styles.tickerDot} cx="112" cy="54" r="4.5" />
        <circle className={styles.tickerDot} cx="128" cy="54" r="4.5" />
        <circle className={styles.tickerDot} cx="144" cy="54" r="4.5" />

        {tickerLines.map((line, index) => (
          <text
            className={`${styles.tickerLine} ${line.done ? styles.tickerDone : ''}`}
            key={line.text}
            x="112"
            y={96 + index * 26}
            style={{
              animationDelay: `${line.delay}s`,
              animationTimingFunction: `steps(${line.chars}, end)`,
            }}
          >
            {line.text}
          </text>
        ))}

        <text className={styles.tickerCaret} x="112" y={96 + 5 * 26 + 6}>
          {'▸'}
        </text>
        <rect className={styles.tickerCursor} x="126" y={96 + 5 * 26 - 6} width="8" height="15" />
      </svg>
    </div>
  );
}

// inputs on the left: your apps, memory, and docs feeding the conversation
const feedNodes = [
  { logo: 'gmail', x: 76, y: 54, path: 'M24 54 H76 C108 68, 116 112, 125 142', delay: 0.2 },
  { logo: 'slack', x: 76, y: 102, path: 'M24 102 H76 C108 112, 116 130, 125 146', delay: 1.4 },
  { logo: 'googlecalendar', x: 76, y: 150, path: 'M24 150 H125', delay: 0.8 },
  { logo: null, x: 76, y: 198, path: 'M24 198 H76 C108 188, 116 168, 125 154', delay: 2.0 },
  { logo: 'googledrive', x: 76, y: 246, path: 'M24 246 H76 C108 232, 116 190, 125 158', delay: 2.6 },
] as const;

// models on the right, taking turns at the dock: Claude, OpenAI, and more
const orbitModels = [
  { logo: 'claude', slot: 'translate(391, 150)', glyphClass: 'orbitGlyphA' },
  { logo: 'openai', slot: 'translate(457, 188.1)', glyphClass: 'orbitGlyphB' },
  { logo: null, slot: 'translate(457, 111.9)', glyphClass: 'orbitGlyphC' },
] as const;

function HeroProviderOrbit() {
  return (
    <div className={styles.heroArt} aria-hidden="true">
      <svg viewBox="0 0 480 300" fill="none">
        {feedNodes.map((node) => (
          <g key={`wire-${node.y}`}>
            <path className={styles.feedWire} d={node.path} />
            <path
              className={styles.feedPacket}
              d={node.path}
              style={{ animationDelay: `${node.delay}s` }}
            />
          </g>
        ))}

        {feedNodes.map((node) => (
          <g key={`node-${node.y}`}>
            <circle className={styles.feedNode} cx={node.x} cy={node.y} r="14" />
            {node.logo ? (
              <image
                href={logoUrl(node.logo)}
                x={node.x - 7}
                y={node.y - 7}
                width="14"
                height="14"
              />
            ) : (
              <g className={styles.feedMemoryGlyph}>
                <rect x={node.x - 5.5} y={node.y - 5.5} width="4" height="4" rx="1" />
                <rect x={node.x + 1.5} y={node.y - 5.5} width="4" height="4" rx="1" />
                <rect x={node.x - 5.5} y={node.y + 1.5} width="4" height="4" rx="1" />
                <rect x={node.x + 1.5} y={node.y + 1.5} width="4" height="4" rx="1" />
              </g>
            )}
          </g>
        ))}

        {/* the conversation persists while the models swap */}
        <rect className={styles.orbitUserBar} x="285" y="90" width="75" height="10" rx="5" />
        <rect className={styles.orbitBotBar} x="155" y="124" width="205" height="10" rx="5" />
        <rect className={styles.orbitBotBar} x="155" y="146" width="155" height="10" rx="5" />
        <rect className={styles.orbitBotBar} x="155" y="168" width="185" height="10" rx="5" />
        <rect className={styles.orbitUserBar} x="300" y="202" width="60" height="10" rx="5" />
        <path className={styles.orbitAnswer} d="M160 241 H335" pathLength={1} />

        <path className={styles.orbitWire} d="M372 150 H375" />
        <circle className={styles.orbitTrack} cx="435" cy="150" r="44" />

        <g className={styles.orbitRotor}>
          {orbitModels.map((model) => (
            <g key={model.logo ?? 'more-models'} transform={model.slot}>
              <g className={styles.orbitCounter}>
                <g className={`${styles.orbitGlyph} ${styles[model.glyphClass]}`}>
                  <circle r="14" />
                  {model.logo ? (
                    <image href={logoUrl(model.logo)} x="-8" y="-8" width="16" height="16" />
                  ) : (
                    <path className={styles.orbitPlus} d="M-3.5 0H3.5 M0-3.5V3.5" />
                  )}
                </g>
              </g>
            </g>
          ))}
        </g>
      </svg>
    </div>
  );
}

function IssueMockup() {
  return (
    <div className={styles.mockupShell}>
      <div className={`${styles.mockup} ${styles.versoSilhouette}`}>
        <aside className={styles.silhouetteSidebar}>
          <div className={styles.silhouetteSidebarHead}>
            <span className={styles.mockTile} />
            <span className={styles.mockLine} />
          </div>

          <div className={styles.mockNav}>
            {sessions.slice(0, 4).map((session, index) => (
              <div
                className={styles.mockNavItem}
                data-selected={index === 2 ? 'true' : undefined}
                key={session[0]}
              >
                <span className={styles.mockTile} />
                <span className={styles.mockLine} />
              </div>
            ))}
          </div>

          <div className={styles.mockNavDivider} />

          <div className={styles.mockNavFoot}>
            <span className={styles.mockLine} />
            <div className={styles.mockNavDot} />
            <div className={styles.mockNavDot} />
            <div className={styles.mockNavDot} />
          </div>
        </aside>

        <section className={styles.silhouetteMain}>
          <header className={styles.silhouetteHeader}>
            <div>
              <span />
              <i />
            </div>
            <div className={styles.silhouetteHeaderActions}>
              <b />
              <b />
            </div>
          </header>

          <div className={styles.silhouetteCanvas}>
            <div className={styles.silhouetteThread}>
              <div className={`${styles.silhouettePrompt} ${styles.demoPrompt}`}>
                <p className={styles.demoPromptText}>Catch me up on the board conversation.</p>
                <i />
              </div>

              <div className={`${styles.silhouetteActivity} ${styles.demoActivityShell}`}>
                <div className={styles.silhouetteActivityHead}>
                  <div className={styles.silhouetteLogoRow}>
                    {appConnections.slice(0, 5).map(([logo, name]) => (
                      <img src={logoUrl(logo)} alt="" aria-hidden="true" key={name} />
                    ))}
                  </div>
                  <span />
                </div>

                <div className={styles.silhouetteRows}>
                  {demoActivity.map(([logo, label, tone], index) => (
                    <div
                      className={`${styles.silhouetteRow} ${styles.demoRow}`}
                      style={{ animationDelay: `${1.7 + index * 0.35}s` }}
                      key={logo}
                    >
                      <img src={logoUrl(logo)} alt="" aria-hidden="true" />
                      <span className={styles.demoRowText}>{label}</span>
                      <em className={styles[tone]} />
                      <i />
                    </div>
                  ))}
                </div>
              </div>

              <div className={`${styles.silhouetteAnswer} ${styles.demoAnswer}`}>
                <p className={styles.demoAnswerText}>
                  You&rsquo;re mostly caught up. Ana shared the Q3 numbers yesterday &mdash;
                  revenue landed 8% above plan &mdash; and the one open question is the hiring
                  budget. Marc asked everyone to confirm the two new roles before
                  Thursday&rsquo;s call.
                </p>
                <span />
                <span />
              </div>
            </div>
          </div>

          <div className={styles.silhouetteComposer}>
            <span />
            <div>
              <i />
              <i />
              <b />
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

function FeatureGraphic({ kind }: { kind: (typeof features)[number]['graphic'] }) {
  if (kind === 'memory') {
    return <MemoryMiniGraphic />;
  }

  if (kind === 'apps') {
    return <AppsMiniGraphic />;
  }

  return <ModelsMiniGraphic />;
}

const miniMemoryHits = new Set(['2-0', '4-1', '6-2']);

const miniMemoryCells = Array.from({ length: 3 }, (_, row) =>
  Array.from({ length: 8 }, (_, col) => ({
    col,
    row,
    // wave radiates from the query cell at (0, 1)
    delay: Math.hypot(col, row - 1) * 0.12 + 0.3,
    hit: miniMemoryHits.has(`${col}-${row}`),
  })),
).flat();

function MemoryMiniGraphic() {
  return (
    <svg className={styles.miniArt} viewBox="0 0 220 96" fill="none" aria-hidden="true">
      {miniMemoryCells.map((cell) => (
        <rect
          className={cell.hit ? styles.memoryHit : styles.memoryCell}
          key={`${cell.col}-${cell.row}`}
          x={30 + cell.col * 20}
          y={10 + cell.row * 20}
          width="9"
          height="9"
          rx="2.5"
          style={{ animationDelay: `${cell.delay}s` }}
        />
      ))}

      <path
        className={styles.memoryAnswer}
        d="M31 78 H160"
        pathLength={1}
        style={{ animationDelay: '2s' }}
      />
      <path
        className={styles.memoryAnswer}
        d="M31 88 H118"
        pathLength={1}
        style={{ animationDelay: '2.3s' }}
      />
    </svg>
  );
}

const miniConstellation = [
  { logo: 'gmail', cx: 26, cy: 16, path: 'M38 22 C64 34, 82 40, 98 46', delay: 0 },
  { logo: 'slack', cx: 18, cy: 48, path: 'M32 48 C56 48, 74 48, 96 48', delay: 0.9 },
  { logo: 'notion', cx: 26, cy: 80, path: 'M38 74 C64 62, 82 56, 98 50', delay: 1.8 },
  { logo: 'googlecalendar', cx: 194, cy: 16, path: 'M182 22 C156 34, 138 40, 122 46', delay: 0.45 },
  { logo: 'todoist', cx: 202, cy: 48, path: 'M188 48 C164 48, 146 48, 124 48', delay: 1.35 },
  { logo: 'googledrive', cx: 194, cy: 80, path: 'M182 74 C156 62, 138 56, 122 50', delay: 2.25 },
] as const;

function AppsMiniGraphic() {
  return (
    <svg className={styles.miniArt} viewBox="0 0 220 96" fill="none" aria-hidden="true">
      {miniConstellation.map((node) => (
        <g key={node.logo}>
          <path className={styles.constellationWire} d={node.path} />
          <path
            className={styles.constellationPacket}
            d={node.path}
            style={{ animationDelay: `${node.delay}s` }}
          />
        </g>
      ))}

      {miniConstellation.map((node) => (
        <g
          className={styles.constellationNode}
          key={`node-${node.logo}`}
          style={{ animationDelay: `${node.delay * -1.4}s` }}
        >
          <circle cx={node.cx} cy={node.cy} r="11" />
          <image
            href={logoUrl(node.logo)}
            x={node.cx - 5}
            y={node.cy - 5}
            width="10"
            height="10"
          />
        </g>
      ))}

      <g className={styles.constellationCenter}>
        <rect x="97" y="35" width="26" height="26" rx="7" />
        <text x="110" y="52" style={{ fontSize: 11 }}>
          v.
        </text>
      </g>
    </svg>
  );
}

function ModelsMiniGraphic() {
  return (
    <svg className={styles.miniArt} viewBox="0 0 220 96" fill="none" aria-hidden="true">
      <circle className={styles.orbitTrack} cx="52" cy="48" r="28" />
      <path className={styles.orbitWire} d="M86 48 H100" />

      <g className={styles.miniOrbitRotor}>
        <g transform="translate(80, 48)">
          <g className={styles.orbitCounter}>
            <g className={`${styles.orbitGlyph} ${styles.orbitGlyphA}`}>
              <circle r="13" />
              <image href={logoUrl('openai')} x="-7" y="-7" width="14" height="14" />
            </g>
          </g>
        </g>
        <g transform="translate(24, 48)">
          <g className={styles.orbitCounter}>
            <g className={`${styles.orbitGlyph} ${styles.orbitGlyphB}`}>
              <circle r="13" />
              <image href={logoUrl('anthropic')} x="-7" y="-7" width="14" height="14" />
            </g>
          </g>
        </g>
      </g>

      {/* the conversation persists while the models swap */}
      <rect className={styles.orbitUserBar} x="150" y="14" width="56" height="8" rx="4" />
      <rect className={styles.orbitBotBar} x="106" y="32" width="100" height="8" rx="4" />
      <rect className={styles.orbitBotBar} x="106" y="48" width="76" height="8" rx="4" />
      <rect className={styles.orbitBotBar} x="106" y="64" width="90" height="8" rx="4" />
      <path className={styles.orbitAnswer} d="M110 84 H180" pathLength={1} style={{ strokeWidth: 6 }} />
    </svg>
  );
}

// a couple of memory cells flare occasionally; the rest sit quiet
const localMemoryCells = [
  { x: 48, y: 150, flare: -1.2 },
  { x: 64, y: 150, flare: null },
  { x: 80, y: 150, flare: -5.6 },
  { x: 96, y: 150, flare: null },
  { x: 48, y: 166, flare: null },
  { x: 64, y: 166, flare: -3.4 },
  { x: 80, y: 166, flare: null },
  { x: 96, y: 166, flare: -7.8 },
] as const;

function LocalFirstGraphic() {
  return (
    <svg className={styles.localFirstArt} viewBox="0 0 480 270" fill="none" aria-hidden="true">
      <rect className={styles.localDevice} x="24" y="28" width="280" height="214" rx="12" />
      <circle className={styles.tickerDot} cx="46" cy="50" r="4" />
      <circle className={styles.tickerDot} cx="60" cy="50" r="4" />
      <circle className={styles.tickerDot} cx="74" cy="50" r="4" />

      {/* the conversation, at home */}
      <rect className={styles.orbitUserBar} x="230" y="72" width="66" height="8" rx="4" />
      <rect className={styles.orbitBotBar} x="48" y="90" width="150" height="8" rx="4" />
      <rect className={styles.orbitBotBar} x="48" y="106" width="118" height="8" rx="4" />

      {localMemoryCells.map((cell) => (
        <rect
          className={cell.flare === null ? styles.localCell : styles.localCellFlare}
          key={`${cell.x}-${cell.y}`}
          x={cell.x}
          y={cell.y}
          width="7"
          height="7"
          rx="2"
          style={cell.flare === null ? undefined : { animationDelay: `${cell.flare}s` }}
        />
      ))}
      <text className={styles.localLabel} x="48" y="205">Everything is stored on your mac</text>

      <path className={styles.localAnswer} d="M48 224 H250" pathLength={1} />

      <path className={styles.localWire} d="M304 135 H360" />
      <path className={`${styles.localPacket} ${styles.localPacketOut}`} d="M306 135 H360" />
      <path className={`${styles.localPacket} ${styles.localPacketBack}`} d="M360 135 H306" />

      <circle className={styles.localProviderRing} cx="388" cy="135" r="26" />
      <circle className={styles.localPing} cx="388" cy="135" r="26" />
      <g className={styles.localProviderMark}>
        <path d="M388 127v16" />
        <path d="m381 131 14 8" />
        <path d="m395 131-14 8" />
      </g>
      <text className={`${styles.localLabel} ${styles.localLabelMid}`} x="388" y="204">
        model provider
      </text>
    </svg>
  );
}

function Divider() {
  return <div className={styles.divider} />;
}

function DiagonalShade({ compact = false }: { compact?: boolean }) {
  return <span className={compact ? styles.diagonalCompact : styles.diagonalShade} aria-hidden="true" />;
}

function ArrowRightIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3 8h9" />
      <path d="m8.5 3.5 4.5 4.5-4.5 4.5" />
    </svg>
  );
}

function logoUrl(name: string) {
  return `https://logos.composio.dev/api/${name}`;
}
