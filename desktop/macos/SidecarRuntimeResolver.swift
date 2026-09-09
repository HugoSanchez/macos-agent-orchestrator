import Foundation

/// Resolves sidecar and Hermes runtime locations without owning process state.
/// Inputs are explicit so release/debug path selection can be unit tested
/// without depending on the test runner's bundle or working directory.
struct SidecarRuntimeResolver {
    static func orchestratorPath(
        environment: [String: String],
        bundleResourcePath: String?,
        currentDirectory: String,
        sourceFilePath: String,
        fileManager: FileManager = .default
    ) -> String {
        if let override = environment["ORCHESTRATOR_PATH"], !override.isEmpty {
            return override
        }

        if let bundleResourcePath {
            let bundled = (bundleResourcePath as NSString).appendingPathComponent("orchestrator")
            if fileManager.fileExists(atPath: bundled) { return bundled }
        }

        let macosDirectory = (sourceFilePath as NSString).deletingLastPathComponent
        let desktopDirectory = (macosDirectory as NSString).deletingLastPathComponent
        let sibling = (desktopDirectory as NSString).appendingPathComponent("orchestrator")
        if fileManager.fileExists(atPath: sibling) { return sibling }

        let currentDirectoryCandidate = (currentDirectory as NSString)
            .appendingPathComponent("orchestrator")
        if fileManager.fileExists(atPath: currentDirectoryCandidate) {
            return currentDirectoryCandidate
        }

        return (currentDirectory as NSString).appendingPathComponent("desktop/orchestrator")
    }

    static func nodePath(
        bundleResourcePath: String?,
        sourceFilePath: String,
        allowDevelopmentFallback: Bool,
        fileManager: FileManager = .default
    ) -> String? {
        if let bundleResourcePath {
            let bundled = (bundleResourcePath as NSString).appendingPathComponent("node/bin/node")
            if fileManager.isExecutableFile(atPath: bundled) { return bundled }
        }

        if allowDevelopmentFallback {
            let macosDirectory = (sourceFilePath as NSString).deletingLastPathComponent
            let desktopDirectory = (macosDirectory as NSString).deletingLastPathComponent
            let developmentNode = (desktopDirectory as NSString)
                .appendingPathComponent("runtime-bundles/node/bin/node")
            if fileManager.isExecutableFile(atPath: developmentNode) { return developmentNode }
        }

        for path in ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"]
            where fileManager.isExecutableFile(atPath: path) {
            return path
        }
        return nil
    }

    static func bundleRoot(
        bundleResourcePath: String?,
        sourceFilePath: String,
        allowDevelopmentFallback: Bool,
        fileManager: FileManager = .default
    ) -> String? {
        if let bundleResourcePath, hasRuntimeArtifacts(at: bundleResourcePath, fileManager: fileManager) {
            return bundleResourcePath
        }

        if allowDevelopmentFallback {
            let macosDirectory = (sourceFilePath as NSString).deletingLastPathComponent
            let desktopDirectory = (macosDirectory as NSString).deletingLastPathComponent
            let developmentRoot = (desktopDirectory as NSString)
                .appendingPathComponent("runtime-bundles")
            if hasRuntimeArtifacts(at: developmentRoot, fileManager: fileManager) {
                return developmentRoot
            }
        }

        return nil
    }

    static func applyBundledRuntimeEnvironment(
        _ environment: inout [String: String],
        bundleRoot: String?,
        homeDirectory: String,
        hermesHomeOverride: String?,
        fileManager: FileManager = .default
    ) {
        guard let bundleRoot else { return }
        let root = bundleRoot as NSString
        let appSupport = (homeDirectory as NSString)
            .appendingPathComponent("Library/Application Support/Verso")
        let hermesHome = (appSupport as NSString).appendingPathComponent("hermes-home")
        let pythonCache = (homeDirectory as NSString)
            .appendingPathComponent("Library/Caches/Verso/python-bytecode")
        try? fileManager.createDirectory(atPath: pythonCache, withIntermediateDirectories: true)

        environment["VERSO_BUNDLED_PYTHON_DIR"] = root.appendingPathComponent("python")
        environment["VERSO_BUNDLED_SITE_PACKAGES_DIR"] = root.appendingPathComponent("site-packages")
        environment["VERSO_BUNDLED_DEFAULTS"] = root.appendingPathComponent("hermes-defaults")
        environment["VERSO_HERMES_HOME"] = hermesHomeOverride ?? hermesHome
        environment["VERSO_PYTHON_CACHE_DIR"] = pythonCache
        environment["PYTHONDONTWRITEBYTECODE"] = "1"
        environment["PYTHONPYCACHEPREFIX"] = pythonCache

        let versionFile = root.appendingPathComponent("BUNDLE_VERSION")
        if let version = try? String(contentsOfFile: versionFile, encoding: .utf8) {
            environment["VERSO_BUNDLE_VERSION"] = version
                .trimmingCharacters(in: .whitespacesAndNewlines)
        }
    }

    private static func hasRuntimeArtifacts(at root: String, fileManager: FileManager) -> Bool {
        let root = root as NSString
        return fileManager.fileExists(atPath: root.appendingPathComponent("python"))
            && fileManager.fileExists(atPath: root.appendingPathComponent("site-packages"))
            && fileManager.fileExists(atPath: root.appendingPathComponent("hermes-defaults"))
    }
}
