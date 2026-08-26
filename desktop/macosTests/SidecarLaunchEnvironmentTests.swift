import XCTest

final class SidecarLaunchEnvironmentTests: XCTestCase {
    func testLaunchEnvironmentSetsAuthParentAndProductBackend() {
        let environment = SidecarLaunchEnvironment.make(
            baseEnvironment: ["PATH": "/custom/bin"],
            runtimeConfiguration: configuration(mode: .managed),
            homeDirectory: "/Users/tester",
            bundleRoot: nil,
            hermesHomeOverride: nil,
            managedSession: nil,
            authToken: "sidecar-secret",
            parentProcessIdentifier: 1234
        )

        XCTAssertEqual(environment["VERSO_RUNTIME_MODE"], "managed")
        XCTAssertEqual(environment["VERSO_BACKEND_URL"], "https://backend.example")
        XCTAssertEqual(environment["VERSO_SIDECAR_AUTH_SECRET"], "sidecar-secret")
        XCTAssertEqual(environment["VERSO_PARENT_PID"], "1234")
        XCTAssertEqual(
            environment["PATH"],
            "/Users/tester/.local/bin:/Users/tester/.hermes/hermes-agent/venv/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/custom/bin"
        )
    }

    func testExplicitBackendIsPreserved() {
        let environment = SidecarLaunchEnvironment.make(
            baseEnvironment: ["VERSO_BACKEND_URL": "https://local.example"],
            runtimeConfiguration: configuration(mode: .managed, backendURL: "https://local.example"),
            homeDirectory: "/Users/tester",
            bundleRoot: nil,
            hermesHomeOverride: nil,
            managedSession: nil,
            authToken: "secret",
            parentProcessIdentifier: 1
        )

        XCTAssertEqual(environment["VERSO_BACKEND_URL"], "https://local.example")
    }

    func testManagedSessionSeedReplacesInheritedIdentity() {
        let environment = SidecarLaunchEnvironment.make(
            baseEnvironment: [
                "VERSO_MANAGED_SESSION_TOKEN": "old-token",
                "VERSO_MANAGED_SESSION_EXPIRES_AT": "old-expiration",
                "VERSO_MANAGED_USER_ID": "old-user",
            ],
            runtimeConfiguration: configuration(mode: .managed),
            homeDirectory: "/Users/tester",
            bundleRoot: nil,
            hermesHomeOverride: nil,
            managedSession: SidecarManagedSessionSeed(
                token: "new-token",
                expiresAt: "2027-01-01T00:00:00Z",
                userId: "new-user"
            ),
            authToken: "secret",
            parentProcessIdentifier: 1
        )

        XCTAssertEqual(environment["VERSO_MANAGED_SESSION_TOKEN"], "new-token")
        XCTAssertEqual(environment["VERSO_MANAGED_SESSION_EXPIRES_AT"], "2027-01-01T00:00:00Z")
        XCTAssertEqual(environment["VERSO_MANAGED_USER_ID"], "new-user")
    }

    func testMissingSessionRemovesInheritedManagedIdentity() {
        let environment = SidecarLaunchEnvironment.make(
            baseEnvironment: [
                "VERSO_MANAGED_SESSION_TOKEN": "stale-token",
                "VERSO_MANAGED_SESSION_EXPIRES_AT": "stale-expiration",
                "VERSO_MANAGED_USER_ID": "stale-user",
            ],
            runtimeConfiguration: configuration(mode: .managed),
            homeDirectory: "/Users/tester",
            bundleRoot: nil,
            hermesHomeOverride: nil,
            managedSession: nil,
            authToken: "secret",
            parentProcessIdentifier: 1
        )

        XCTAssertNil(environment["VERSO_MANAGED_SESSION_TOKEN"])
        XCTAssertNil(environment["VERSO_MANAGED_SESSION_EXPIRES_AT"])
        XCTAssertNil(environment["VERSO_MANAGED_USER_ID"])
    }

    func testLocalModeForcesManagedServicesOffAndScrubsInheritedIdentity() {
        let environment = SidecarLaunchEnvironment.make(
            baseEnvironment: [
                "VERSO_BACKEND_URL": "https://backend.example",
                "VERSO_MANAGED_SESSION_TOKEN": "stale-token",
                "VERSO_MANAGED_SESSION_EXPIRES_AT": "stale-expiration",
                "VERSO_MANAGED_USER_ID": "stale-user",
            ],
            runtimeConfiguration: configuration(mode: .local),
            homeDirectory: "/Users/tester",
            bundleRoot: nil,
            hermesHomeOverride: nil,
            managedSession: SidecarManagedSessionSeed(
                token: "new-token",
                expiresAt: "2027-01-01T00:00:00Z",
                userId: "new-user"
            ),
            authToken: "secret",
            parentProcessIdentifier: 1
        )

        XCTAssertEqual(environment["VERSO_RUNTIME_MODE"], "local")
        XCTAssertEqual(environment["VERSO_BACKEND_URL"], "off")
        XCTAssertNil(environment["VERSO_MANAGED_SESSION_TOKEN"])
        XCTAssertNil(environment["VERSO_MANAGED_SESSION_EXPIRES_AT"])
        XCTAssertNil(environment["VERSO_MANAGED_USER_ID"])
    }

    func testBundledLocalRuntimeUsesRuntimeScopedHermesHome() {
        let environment = SidecarLaunchEnvironment.make(
            baseEnvironment: [:],
            runtimeConfiguration: configuration(mode: .local),
            homeDirectory: "/Users/tester",
            bundleRoot: "/bundle",
            hermesHomeOverride: nil,
            managedSession: nil,
            authToken: "secret",
            parentProcessIdentifier: 1
        )

        XCTAssertEqual(
            environment["VERSO_HERMES_HOME"],
            "/Users/tester/Library/Application Support/Verso/runtime/local/hermes-home"
        )
    }

    func testBundledManagedRuntimeRetainsManagedHermesHome() {
        let environment = SidecarLaunchEnvironment.make(
            baseEnvironment: [:],
            runtimeConfiguration: configuration(mode: .managed),
            homeDirectory: "/Users/tester",
            bundleRoot: "/bundle",
            hermesHomeOverride: nil,
            managedSession: nil,
            authToken: "secret",
            parentProcessIdentifier: 1
        )

        XCTAssertEqual(
            environment["VERSO_HERMES_HOME"],
            "/Users/tester/Library/Application Support/Verso/hermes-home"
        )
    }

    private func configuration(
        mode: VersoRuntimeMode,
        backendURL: String? = "https://backend.example"
    ) -> VersoRuntimeConfiguration {
        VersoRuntimeConfiguration(
            mode: mode,
            managedBackendURL: backendURL,
            managedFrontendURL: "https://frontend.example/login",
            sentryDSN: nil,
            sparkleFeedURL: nil,
            sparklePublicKey: nil
        )
    }
}
