import XCTest

final class VersoRuntimeConfigurationTests: XCTestCase {
    func testEnvironmentModeOverridesBundleDefault() {
        let configuration = VersoRuntimeConfiguration.resolve(
            environment: ["VERSO_RUNTIME_MODE": "managed"],
            infoDictionary: [VersoRuntimeConfiguration.defaultModeInfoKey: "local"]
        )

        XCTAssertEqual(configuration.mode, .managed)
    }

    func testBundleDefaultIsUsedWithoutEnvironmentOverride() {
        let configuration = VersoRuntimeConfiguration.resolve(
            environment: [:],
            infoDictionary: [VersoRuntimeConfiguration.defaultModeInfoKey: "byo"]
        )

        XCTAssertEqual(configuration.mode, .byo)
    }

    func testMissingEmptyAndInvalidModesFailClosedToLocal() {
        let configurations = [
            VersoRuntimeConfiguration.resolve(environment: [:], infoDictionary: [:]),
            VersoRuntimeConfiguration.resolve(
                environment: ["VERSO_RUNTIME_MODE": "  "],
                infoDictionary: [VersoRuntimeConfiguration.defaultModeInfoKey: "managed"]
            ),
            VersoRuntimeConfiguration.resolve(
                environment: ["VERSO_RUNTIME_MODE": "enterprise"],
                infoDictionary: [VersoRuntimeConfiguration.defaultModeInfoKey: "managed"]
            ),
            VersoRuntimeConfiguration.resolve(
                environment: [:],
                infoDictionary: [VersoRuntimeConfiguration.defaultModeInfoKey: "invalid"]
            ),
        ]

        XCTAssertTrue(configurations.allSatisfy { $0.mode == .local })
    }

    func testManagedServiceIdentifiersRemainInertOutsideManagedMode() {
        let configuration = VersoRuntimeConfiguration.resolve(
            environment: [:],
            infoDictionary: [
                VersoRuntimeConfiguration.defaultModeInfoKey: "local",
                "SentryDSN": "https://sentry.example/1",
                "SUFeedURL": "https://updates.example/appcast.xml",
                "SUPublicEDKey": "public-key",
            ]
        )

        XCTAssertEqual(configuration.sentryDSN, "https://sentry.example/1")
        XCTAssertFalse(configuration.enablesTelemetry)
        XCTAssertFalse(configuration.enablesUpdates)
    }

    func testMalformedTelemetryAndUpdateURLsRemainDisabled() {
        let configuration = VersoRuntimeConfiguration.resolve(
            environment: ["VERSO_RUNTIME_MODE": "managed"],
            infoDictionary: [
                "SentryDSN": "not a URL",
                "SUFeedURL": "file:///tmp/appcast.xml",
                "SUPublicEDKey": "public-key",
            ]
        )

        XCTAssertFalse(configuration.enablesTelemetry)
        XCTAssertFalse(configuration.enablesUpdates)
    }

    func testStartupPolicyKeepsManagedGateAndStartsLocalImmediately() {
        let local = configuration(mode: .local)
        let managed = configuration(mode: .managed)

        XCTAssertEqual(
            AppStartupPolicy.destination(
                configuration: local,
                isRestoringManagedSession: true,
                managedSession: nil
            ),
            .content
        )
        XCTAssertTrue(AppStartupPolicy.shouldStartSidecarAtLaunch(configuration: local))
        XCTAssertEqual(
            AppStartupPolicy.destination(
                configuration: managed,
                isRestoringManagedSession: true,
                managedSession: nil
            ),
            .restoringManagedSession
        )
        XCTAssertFalse(AppStartupPolicy.shouldStartSidecarAtLaunch(configuration: managed))
    }

    private func configuration(mode: VersoRuntimeMode) -> VersoRuntimeConfiguration {
        VersoRuntimeConfiguration(
            mode: mode,
            managedBackendURL: "https://backend.example",
            sentryDSN: "https://sentry.example/1",
            sparkleFeedURL: "https://updates.example/appcast.xml",
            sparklePublicKey: "public-key"
        )
    }
}
