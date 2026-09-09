import Foundation
import XCTest

final class SidecarRuntimeResolverTests: XCTestCase {
    private var temporaryDirectory: URL!

    override func setUpWithError() throws {
        temporaryDirectory = FileManager.default.temporaryDirectory
            .appendingPathComponent("verso-sidecar-tests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: temporaryDirectory, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: temporaryDirectory)
    }

    func testExplicitOrchestratorOverrideHasHighestPrecedence() {
        let resolved = SidecarRuntimeResolver.orchestratorPath(
            environment: ["ORCHESTRATOR_PATH": "/explicit/orchestrator"],
            bundleResourcePath: temporaryDirectory.path,
            currentDirectory: "/working",
            sourceFilePath: "/repo/desktop/macos/SidecarManager.swift"
        )

        XCTAssertEqual(resolved, "/explicit/orchestrator")
    }

    func testBundledOrchestratorPrecedesDevelopmentPaths() throws {
        let orchestrator = temporaryDirectory.appendingPathComponent("orchestrator", isDirectory: true)
        try FileManager.default.createDirectory(at: orchestrator, withIntermediateDirectories: true)

        let resolved = SidecarRuntimeResolver.orchestratorPath(
            environment: [:],
            bundleResourcePath: temporaryDirectory.path,
            currentDirectory: "/working",
            sourceFilePath: "/repo/desktop/macos/SidecarManager.swift"
        )

        XCTAssertEqual(resolved, orchestrator.path)
    }

    func testDevelopmentNodePrecedesSystemFallback() throws {
        let desktop = temporaryDirectory
            .appendingPathComponent("repo/desktop", isDirectory: true)
        let node = desktop
            .appendingPathComponent("runtime-bundles/node/bin/node")
        try FileManager.default.createDirectory(
            at: node.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try Data("#!/bin/sh\n".utf8).write(to: node)
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o755],
            ofItemAtPath: node.path
        )

        let resolved = SidecarRuntimeResolver.nodePath(
            bundleResourcePath: temporaryDirectory
                .appendingPathComponent("app-resources")
                .path,
            sourceFilePath: desktop
                .appendingPathComponent("macos/SidecarManager.swift")
                .path,
            allowDevelopmentFallback: true
        )

        XCTAssertEqual(resolved, node.path)
    }

    func testRuntimeBundleRequiresAllArtifacts() throws {
        for component in ["python", "site-packages"] {
            try FileManager.default.createDirectory(
                at: temporaryDirectory.appendingPathComponent(component),
                withIntermediateDirectories: true
            )
        }
        XCTAssertNil(
            SidecarRuntimeResolver.bundleRoot(
                bundleResourcePath: temporaryDirectory.path,
                sourceFilePath: "/repo/desktop/macos/SidecarManager.swift",
                allowDevelopmentFallback: false
            )
        )

        try FileManager.default.createDirectory(
            at: temporaryDirectory.appendingPathComponent("hermes-defaults"),
            withIntermediateDirectories: true
        )
        XCTAssertEqual(
            SidecarRuntimeResolver.bundleRoot(
                bundleResourcePath: temporaryDirectory.path,
                sourceFilePath: "/repo/desktop/macos/SidecarManager.swift",
                allowDevelopmentFallback: false
            ),
            temporaryDirectory.path
        )
    }

    func testBundledEnvironmentPreservesHermesOverrideAndRedirectsBytecode() throws {
        for component in ["python", "site-packages", "hermes-defaults"] {
            try FileManager.default.createDirectory(
                at: temporaryDirectory.appendingPathComponent(component),
                withIntermediateDirectories: true
            )
        }
        try Data("runtime-v3\n".utf8).write(
            to: temporaryDirectory.appendingPathComponent("BUNDLE_VERSION")
        )
        var environment: [String: String] = [:]

        SidecarRuntimeResolver.applyBundledRuntimeEnvironment(
            &environment,
            bundleRoot: temporaryDirectory.path,
            homeDirectory: "/Users/tester",
            hermesHomeOverride: "/isolated/hermes"
        )

        XCTAssertEqual(environment["VERSO_HERMES_HOME"], "/isolated/hermes")
        XCTAssertEqual(environment["VERSO_BUNDLE_VERSION"], "runtime-v3")
        XCTAssertEqual(environment["PYTHONDONTWRITEBYTECODE"], "1")
        XCTAssertEqual(
            environment["PYTHONPYCACHEPREFIX"],
            "/Users/tester/Library/Caches/Verso/python-bytecode"
        )
        XCTAssertEqual(
            environment["VERSO_BUNDLED_SITE_PACKAGES_DIR"],
            temporaryDirectory.appendingPathComponent("site-packages").path
        )
    }
}
