import type { Metadata } from 'next';
import Link from 'next/link';
import styles from './privacy.module.css';

export const metadata: Metadata = {
  title: 'Privacy & data — Verso',
  description: 'Where Verso stores memory, how connected apps and model providers process context, and what managed services retain.',
  alternates: { canonical: '/privacy' },
  openGraph: {
    title: 'Privacy & data — Verso',
    description: 'How Verso handles local memory, connected-app content, and service information.',
    url: '/privacy',
  },
};

export default function PrivacyPage() {
  return (
    <main className={styles.page}>
      <Link href="/" className={styles.back}>← Back to Verso</Link>
      <article>
        <header>
          <h1>Privacy &amp; data</h1>
          <p className={styles.updated}>Updated September 8, 2026</p>
          <p>
            Verso stores your conversations and indexed memory on your Mac. Connected apps and
            AI models also involve remote services. This page explains what stays local,
            what those services process, and what information supports the managed service.
          </p>
        </header>

        <section aria-labelledby="local-data">
          <h2 id="local-data">Conversations and memory</h2>
          <p>
            Chat history, workspace files, and the memory built from your connected apps are
            stored on your Mac. Memory is indexed and searched locally. When an agent uses a
            memory or file, the relevant content becomes part of the context sent to your
            selected model provider.
          </p>
        </section>

        <section aria-labelledby="connected-apps">
          <h2 id="connected-apps">Connected apps and zero data retention</h2>
          <p>
            In managed mode, connected-app requests pass through Verso’s backend and Composio
            to the app you authorize. Responses pass back through those services to your Mac.
            This includes background requests for the app-memory sources you enable.
          </p>
          <p>
            Verso’s managed Composio project has a paid zero-data-retention agreement for
            connected-app content. Verso’s backend forwards tool-call content rather than
            saving request or response bodies in its application database. Its tool-execution
            logs contain selected diagnostic metadata, not argument values, response bodies,
            or raw upstream error messages.
          </p>
          <p>
            Zero data retention does not mean that content never passes through a server.
            Account information and the connection records needed to operate the service
            are separate from tool-call content.
          </p>
          <p>
            If you use a local build with your own Composio project, connected-app requests
            go directly from your Mac to Composio without Verso’s backend. Your project’s
            agreement and settings apply; Verso’s managed zero-data-retention agreement does
            not automatically cover your project.
          </p>
        </section>

        <section aria-labelledby="providers">
          <h2 id="providers">Model providers and other services</h2>
          <p>
            Your selected model provider receives the prompts and context needed to answer
            you, which can include messages, attachments, retrieved memories, and tool results.
            That provider’s own data-handling terms apply. Composio’s zero-data-retention
            agreement does not extend to your model provider.
          </p>
          <p>
            Verso supports custom model providers, so you can choose a service with privacy
            terms that suit your needs, including a provider offering zero data retention.
            You can also use a compatible model endpoint hosted on your own infrastructure
            or on your Mac. A model running on your Mac can keep inference local; connected-app
            requests and other external tools still follow their own data flows.
          </p>
          <p>
            For the Anthropic API, Anthropic’s standard policy is to automatically delete
            inputs and outputs within 30 days. Exceptions apply for certain models or
            features, usage-policy enforcement, legal requirements, and different contractual
            arrangements. See <a href="https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data">Anthropic’s API retention policy</a>.
          </p>
          <p>
            Websites, connected apps, and custom MCP connectors also receive information
            needed for the actions you ask an agent to perform, under their own policies.
          </p>
        </section>

        <section aria-labelledby="service-data">
          <h2 id="service-data">Account, usage, and diagnostic information</h2>
          <p>
            Managed accounts use WorkOS for sign-in. Verso stores account and device information,
            including your email address, account identifiers, device label, and service access
            status. It also records usage events such as creating a chat, sending or completing
            a message, and adding a connection. These events contain identifiers, timestamps,
            and tool-call counts, rather than message text or tool-call content.
          </p>
          <p>
            Service diagnostics include tool names, argument counts, outcome indicators, and
            connection identifiers or status codes for disconnect failures. Managed builds
            configured for crash reporting send error and diagnostic information to Sentry.
            Account and usage records are distinct from your locally stored conversations
            and memory.
          </p>
          <p>
            Local source builds disable Verso’s managed account service, product analytics,
            Sentry reporting, and update feed. They still contact the providers, websites,
            and connectors you choose to use.
          </p>
        </section>

        <section aria-labelledby="controls">
          <h2 id="controls">Stopping access and removing memory</h2>
          <p>
            Turning off an app-memory source stops future ingestion; it does not erase existing
            memories. Disconnecting an app removes its connection and attempts to revoke access.
            Some providers require an additional manual revocation step, which Verso reports.
          </p>
          <p>
            Previously indexed content stays on your Mac after disconnection. The source-reset
            operation removes that source’s ingested documents, but does not erase agent-written
            memory pages or conversations that may contain information from them. Deleting an
            item in the original app is not guaranteed to delete Verso’s existing copy.
          </p>
        </section>

        <p className={styles.source}>
          Verso is open source. You can inspect the implementation and local setup instructions
          in the <a href="https://github.com/HugoSanchez/macos-agent-orchestrator">repository</a>.
        </p>
      </article>
    </main>
  );
}
