import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

export interface BundledRuntimePaths {
  /** <app>/Resources/python — one subdir per arch (currently {arm64}). */
  bundledPythonDir: string;
  /** <app>/Resources/site-packages — one subdir per arch, each containing
   *  site-packages/ (Python packages) and bin/hermes (console-script). */
  bundledSitePackagesDir: string;
  /** <app>/Resources/hermes-defaults — seed config.yaml + SOUL.md + memories/. */
  bundledDefaultsDir: string;
  /** ~/Library/Application Support/Verso/hermes-home — Hermes' on-disk profile. */
  hermesHome: string;
  /** Contents of <app>/Resources/BUNDLE_VERSION — surfaced in diagnostics. */
  bundleVersion: string;
}

/** What the orchestrator needs to spawn the bundled Hermes. */
export interface BundledHermesInvocation {
  /** Bundled CPython interpreter. */
  python: string;
  /** Console-script path (pip-generated). Run as `python script ...`. */
  hermesScript: string;
  /** Goes into PYTHONPATH so Hermes' deps resolve. */
  sitePackages: string;
}

export function readBundledRuntimePaths(): BundledRuntimePaths | null {
  const bundledPythonDir = process.env.VERSO_BUNDLED_PYTHON_DIR?.trim();
  const bundledSitePackagesDir = process.env.VERSO_BUNDLED_SITE_PACKAGES_DIR?.trim();
  const bundledDefaultsDir = process.env.VERSO_BUNDLED_DEFAULTS?.trim();
  const hermesHome = process.env.VERSO_HERMES_HOME?.trim();
  const bundleVersion = process.env.VERSO_BUNDLE_VERSION?.trim();

  if (
    !bundledPythonDir
    || !bundledSitePackagesDir
    || !bundledDefaultsDir
    || !hermesHome
    || !bundleVersion
  ) {
    return null;
  }

  return { bundledPythonDir, bundledSitePackagesDir, bundledDefaultsDir, hermesHome, bundleVersion };
}

export function isBundledRuntime(): boolean {
  return readBundledRuntimePaths() !== null;
}

function archSlug(): string {
  return process.arch === 'x64' ? 'x86_64' : process.arch;
}

/**
 * Resolve the bundled Python interpreter + Hermes script + site-packages dir
 * for the host arch. Returns null when not running inside a Release build
 * (env vars unset) or when the bundle is missing the expected arch.
 */
export function getBundledHermesInvocation(): BundledHermesInvocation | null {
  const paths = readBundledRuntimePaths();
  if (!paths) return null;

  const arch = archSlug();
  const python = join(paths.bundledPythonDir, arch, 'python', 'bin', 'python3.11');
  const hermesScript = join(paths.bundledSitePackagesDir, arch, 'bin', 'hermes');
  const sitePackages = join(paths.bundledSitePackagesDir, arch, 'site-packages');

  if (!existsSync(python) || !existsSync(hermesScript) || !existsSync(sitePackages)) {
    return null;
  }

  return { python, hermesScript, sitePackages };
}

/**
 * Path to the bundled Python interpreter for the host arch. Used by code
 * paths that need to spawn Python directly (e.g. the MCP server) rather
 * than via the Hermes console-script. Returns null outside Release.
 */
export function getBundledPython(): string | null {
  return getBundledHermesInvocation()?.python ?? null;
}

/**
 * Seed ~/Library/Application Support/Verso/hermes-home/ from the bundled
 * defaults the first time. Never overwrites existing files — once the user
 * has memories, an auth.json, or a customized config.yaml, they're sacred.
 */
export function seedHermesHomeFromBundle(): void {
  const paths = readBundledRuntimePaths();
  if (!paths) return;

  mkdirSync(paths.hermesHome, { recursive: true });
  copyTreeNoOverwrite(paths.bundledDefaultsDir, paths.hermesHome);
}

function copyTreeNoOverwrite(srcDir: string, dstDir: string): void {
  if (!existsSync(srcDir)) return;
  for (const entry of readdirSync(srcDir)) {
    const src = join(srcDir, entry);
    const dst = join(dstDir, entry);
    if (statSync(src).isDirectory()) {
      mkdirSync(dst, { recursive: true });
      copyTreeNoOverwrite(src, dst);
    } else if (!existsSync(dst)) {
      mkdirSync(dirname(dst), { recursive: true });
      copyFileSync(src, dst);
    }
  }
}
