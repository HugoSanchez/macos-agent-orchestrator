import Foundation
import Sentry

enum Telemetry {
    private static var isEnabled = false

    static func configure(configuration: VersoRuntimeConfiguration) {
        guard configuration.enablesTelemetry, let dsn = configuration.sentryDSN else {
            isEnabled = false
            return
        }

        SentrySDK.start { options in
            options.dsn = dsn
            #if DEBUG
            options.environment = "development"
            #else
            options.environment = "production"
            #endif
        }
        isEnabled = true
    }

    /// `context` is a short tag (e.g. "sidecar-launch") that becomes a
    /// searchable tag in Sentry — without it, two sites throwing the same
    /// URLError look identical in the dashboard.
    static func reportError(_ error: Error, context: String) {
        guard isEnabled else { return }
        SentrySDK.capture(error: error) { scope in
            scope.setTag(value: context, key: "context")
        }
    }
}
