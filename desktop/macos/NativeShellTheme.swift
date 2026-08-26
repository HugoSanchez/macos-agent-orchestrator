import SwiftUI

struct ConductorThemePalette {
    let sidebarTop: Color
    let sidebarBottom: Color
    let sidebarTintOpacity: Double
    let mainCanvas: Color
    let inputFill: Color
    let inputStroke: Color
    let rightTop: Color
    let rightBottom: Color
    let verticalDivider: Color
    let horizontalDivider: Color
    let rightDividerThickness: CGFloat
    let centerRightDividerThickness: CGFloat
    let headerTopStart: Color
    let headerTopEnd: Color
    let headerTabsStart: Color
    let headerTabsEnd: Color
    let headerDivider: Color
    let headerBottomDivider: Color
    let headerBottomDividerThickness: CGFloat
    let headerActiveLine: Color
    let footerDivider: Color
    let footerIcon: Color
    let windowBorder: Color

    // Text roles (semantic ink hierarchy). Phase 2 collapses the Phase-1b
    // micro-drift onto the canonical editorial ink scale: `ink2` = ink-2 and
    // `inkDimRow` = ink-dim (they no longer diverge from ink2 / inkDim).
    let ink: Color        // primary text — session-row titles (ink)
    let ink2: Color       // list-item names — connections, routines, skills (ink-2)
    let inkDim: Color     // section labels, chevrons, empty/secondary text (ink-dim)
    let inkDimRow: Color  // session-row trailing meta (timestamps, hover icons) (ink-dim)
    let inkFaint: Color   // index numbers, row meta / times (ink-faint)
    let green: Color      // active session + streaming/unread accent (green)
    let orange: Color     // needs-auth / failed connection status (orange)
    let iconRing: Color   // traffic-light idle ring (icon-ring)

    // Sidebar surface fills.
    let rowSelectedFill: Color
    let rowHoverFill: Color
    let cardFill: Color

    // Destructive / warning text (system red at per-mode opacities).
    let danger: Color        // inline error text
    let dangerStrong: Color  // routine delete confirmation

    // Connection-logo fallback tile.
    let iconFallbackFill: Color
    let iconFallbackText: Color

    // Floating sidebar toast.
    let toastText: Color
    let toastFill: Color
    let toastStroke: Color

    static let windowCornerRadius: CGFloat = 10
}

enum ConductorThemes {
    // Editorial palette (Phase 2). Flat paper surfaces — the sidebar gradient
    // collapses to a single paper stop and `sidebarTintOpacity` = 1.0 fully
    // covers the blur material, so no structural edits are needed.
    static let dark = ConductorThemePalette(
        sidebarTop: Color(red: 30/255, green: 32/255, blue: 34/255),      // #1E2022 paper
        sidebarBottom: Color(red: 30/255, green: 32/255, blue: 34/255),   // #1E2022 paper
        sidebarTintOpacity: 1.0,
        mainCanvas: Color(red: 30/255, green: 32/255, blue: 34/255),      // #1E2022 paper
        inputFill: Color(red: 38/255, green: 40/255, blue: 43/255),       // #26282B paper-2
        inputStroke: Color.white.opacity(0.10),                           // line
        rightTop: Color(red: 30/255, green: 32/255, blue: 34/255),        // #1E2022 paper
        rightBottom: Color(red: 30/255, green: 32/255, blue: 34/255),     // #1E2022 paper
        verticalDivider: Color.white.opacity(0.10),                       // line
        horizontalDivider: Color.white.opacity(0.10),                     // line
        rightDividerThickness: 1,
        centerRightDividerThickness: 1,
        headerTopStart: Color(red: 30/255, green: 32/255, blue: 34/255),  // #1E2022 paper (flat)
        headerTopEnd: Color(red: 30/255, green: 32/255, blue: 34/255),    // #1E2022 paper (flat)
        headerTabsStart: Color(red: 30/255, green: 32/255, blue: 34/255), // #1E2022 paper (flat)
        headerTabsEnd: Color(red: 30/255, green: 32/255, blue: 34/255),   // #1E2022 paper (flat)
        headerDivider: Color.white.opacity(0.10),                         // line
        headerBottomDivider: Color.white.opacity(0.06),                   // line-soft
        headerBottomDividerThickness: 1,
        headerActiveLine: Color.white.opacity(0.90),                      // ink
        footerDivider: Color.white.opacity(0.06),                         // line-soft
        footerIcon: Color.white.opacity(0.46),                            // ink-dim
        windowBorder: Color.white.opacity(0.10),                          // line
        ink: Color.white.opacity(0.90),
        ink2: Color.white.opacity(0.74),
        inkDim: Color.white.opacity(0.46),
        inkDimRow: Color.white.opacity(0.46),
        inkFaint: Color.white.opacity(0.30),
        green: Color(red: 166/255, green: 192/255, blue: 122/255),   // #A6C07A
        orange: Color(red: 214/255, green: 143/255, blue: 92/255),   // #D68F5C
        iconRing: Color.white.opacity(0.14),
        rowSelectedFill: Color.white.opacity(0.05),
        rowHoverFill: Color.white.opacity(0.03),
        cardFill: Color(red: 38/255, green: 40/255, blue: 43/255).opacity(0.38), // paper-2 × 0.38
        danger: Color.red.opacity(0.88),
        dangerStrong: Color.red.opacity(0.92),
        iconFallbackFill: Color.white.opacity(0.08),
        iconFallbackText: Color.white.opacity(0.7),
        toastText: Color.white.opacity(0.90),                             // ink
        toastFill: Color(red: 38/255, green: 40/255, blue: 43/255),       // #26282B paper-2
        toastStroke: Color.white.opacity(0.10)                            // line
    )

    // Light mode — same editorial palette, warm paper. Row fills switch from
    // white overlays (invisible on paper) to ink-tinted lines.
    static let light = ConductorThemePalette(
        sidebarTop: Color(red: 245/255, green: 242/255, blue: 234/255),     // #F5F2EA paper
        sidebarBottom: Color(red: 245/255, green: 242/255, blue: 234/255),  // #F5F2EA paper
        sidebarTintOpacity: 1.0,
        mainCanvas: Color(red: 245/255, green: 242/255, blue: 234/255),     // #F5F2EA paper
        inputFill: Color(red: 239/255, green: 235/255, blue: 224/255),      // #EFEBE0 paper-2
        inputStroke: Color(red: 50/255, green: 48/255, blue: 40/255).opacity(0.11),  // line
        rightTop: Color(red: 245/255, green: 242/255, blue: 234/255),       // #F5F2EA paper
        rightBottom: Color(red: 245/255, green: 242/255, blue: 234/255),    // #F5F2EA paper
        verticalDivider: Color(red: 50/255, green: 48/255, blue: 40/255).opacity(0.11),   // line
        horizontalDivider: Color(red: 50/255, green: 48/255, blue: 40/255).opacity(0.11), // line
        rightDividerThickness: 0.5,
        centerRightDividerThickness: 0,
        headerTopStart: Color(red: 245/255, green: 242/255, blue: 234/255),  // paper (flat)
        headerTopEnd: Color(red: 245/255, green: 242/255, blue: 234/255),    // paper (flat)
        headerTabsStart: Color(red: 245/255, green: 242/255, blue: 234/255), // paper (flat)
        headerTabsEnd: Color(red: 245/255, green: 242/255, blue: 234/255),   // paper (flat)
        headerDivider: Color(red: 50/255, green: 48/255, blue: 40/255).opacity(0.11),        // line
        headerBottomDivider: Color(red: 50/255, green: 48/255, blue: 40/255).opacity(0.07),  // line-soft
        headerBottomDividerThickness: 0.5,
        headerActiveLine: Color(red: 52/255, green: 51/255, blue: 45/255),   // #34332D ink
        footerDivider: Color(red: 50/255, green: 48/255, blue: 40/255).opacity(0.07),  // line-soft
        footerIcon: Color(red: 143/255, green: 140/255, blue: 127/255),      // #8F8C7F ink-dim
        windowBorder: Color(red: 50/255, green: 48/255, blue: 40/255).opacity(0.11),   // line
        ink: Color(red: 52/255, green: 51/255, blue: 45/255),                // #34332D
        ink2: Color(red: 85/255, green: 83/255, blue: 74/255),               // #55534A
        inkDim: Color(red: 143/255, green: 140/255, blue: 127/255),          // #8F8C7F
        inkDimRow: Color(red: 143/255, green: 140/255, blue: 127/255),       // #8F8C7F ink-dim
        inkFaint: Color(red: 182/255, green: 179/255, blue: 165/255),        // #B6B3A5
        green: Color(red: 109/255, green: 122/255, blue: 76/255),            // #6D7A4C
        orange: Color(red: 178/255, green: 106/255, blue: 57/255),           // #B26A39
        iconRing: Color(red: 50/255, green: 48/255, blue: 40/255).opacity(0.14),
        rowSelectedFill: Color(red: 50/255, green: 48/255, blue: 40/255).opacity(0.07),
        rowHoverFill: Color(red: 50/255, green: 48/255, blue: 40/255).opacity(0.045),
        cardFill: Color(red: 239/255, green: 235/255, blue: 224/255).opacity(0.82), // paper-2 × 0.82
        danger: Color.red.opacity(0.74),
        dangerStrong: Color.red.opacity(0.78),
        iconFallbackFill: Color.black.opacity(0.06),
        iconFallbackText: Color.black.opacity(0.55),
        toastText: Color(red: 52/255, green: 51/255, blue: 45/255),          // #34332D ink
        toastFill: Color(red: 245/255, green: 242/255, blue: 234/255),       // #F5F2EA paper
        toastStroke: Color(red: 50/255, green: 48/255, blue: 40/255).opacity(0.11)  // line
    )
}

/// Shared font ramp for the native shell. Sizes are unchanged; emphasized roles
/// reference bundled face weights directly, not synthesized ones.
enum ConductorType {
    static let sectionLabel = Font.custom("IBM Plex Sans SemiBold", size: 11)
    static let disclosure = Font.custom("IBM Plex Sans SemiBold", size: 8)
    static let rowTitle = Font.custom("IBM Plex Sans", size: 13)
    static let rowTitleStrong = Font.custom("IBM Plex Sans Bold", size: 13) // selected session title
    static let meta = Font.custom("IBM Plex Sans", size: 12)      // ago / status / row meta (ink-faint)
    static let caption = Font.custom("IBM Plex Sans", size: 11)
    static let captionStrong = Font.custom("IBM Plex Sans Bold", size: 11)
    static let placeholder = Font.custom("IBM Plex Sans", size: 12)
    // SF Symbol glyph sizes (kept on Font.system since they size symbols, not
    // the mono UI text). Centralized here so call sites carry no font literals.
    static let rowActionIcon = Font.system(size: 11, weight: .medium)      // session hover pencil/archive
    static let rowActionIconSmall = Font.system(size: 10, weight: .medium)  // cron hover delete
    static let trafficGlyph = Font.system(size: 8, weight: .bold)          // traffic-light hover glyph
}
