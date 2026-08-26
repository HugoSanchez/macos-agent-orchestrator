import AppKit
import SwiftUI

/// Minimal editorial palette for the sign-in screen. The main shell carries the
/// full `ConductorThemePalette` (private to ContentView); the sign-in screen
/// only needs paper, the ink ramp, and the primary-button vocabulary, so it
/// keeps a self-contained slice of the same tokens rather than exposing the
/// heavyweight struct. Values mirror `tokens.css` / `ConductorThemes`.
private struct SignInPalette {
    let paper: Color
    let ink: Color
    let ink2: Color
    let inkDim: Color
    let ringColor: Color
    let primaryFill: Color
    let primaryFillHover: Color
    let primaryText: Color
    let danger: Color

    static let dark = SignInPalette(
        paper: Color(red: 30/255, green: 32/255, blue: 34/255),        // #1E2022 paper
        ink: Color.white.opacity(0.90),                                // ink
        ink2: Color.white.opacity(0.74),                               // ink-2
        inkDim: Color.white.opacity(0.46),                             // ink-dim
        ringColor: Color.white.opacity(0.14),                          // icon-ring
        primaryFill: Color.white.opacity(0.92),                        // primary-btn-bg
        primaryFillHover: Color.white,                                 // primary-btn-bg-hover
        primaryText: Color(red: 17/255, green: 17/255, blue: 17/255),  // #111 primary-btn-text
        danger: Color(red: 255/255, green: 154/255, blue: 139/255)     // #FF9A8B danger-soft
    )

    static let light = SignInPalette(
        paper: Color(red: 245/255, green: 242/255, blue: 234/255),     // #F5F2EA paper
        ink: Color(red: 52/255, green: 51/255, blue: 45/255),          // #34332D ink
        ink2: Color(red: 85/255, green: 83/255, blue: 74/255),         // #55534A ink-2
        inkDim: Color(red: 143/255, green: 140/255, blue: 127/255),    // #8F8C7F ink-dim
        ringColor: Color(red: 50/255, green: 48/255, blue: 40/255).opacity(0.14),  // icon-ring
        primaryFill: Color(red: 17/255, green: 17/255, blue: 17/255),  // #111 primary-btn-bg
        primaryFillHover: Color.black,                                 // primary-btn-bg-hover
        primaryText: Color.white,                                      // primary-btn-text
        danger: Color(red: 192/255, green: 57/255, blue: 43/255)       // #C0392B danger
    )
}

struct SignInView: View {
    @ObservedObject var managedSessionStore: ManagedSessionStore
    let frontendURL: String?
    // Match the shell's theme source (defaults to dark) so the sign-in screen
    // reads as the same app before a session exists.
    @AppStorage("isDarkMode") private var isDarkMode = true
    @State private var errorMessage: String?
    @State private var isButtonHovered = false

    private static let contentWidth: CGFloat = 300

    private var palette: SignInPalette { isDarkMode ? .dark : .light }

    var body: some View {
        ZStack {
            palette.paper
                .ignoresSafeArea()

            VStack(spacing: 0) {
                header
                Spacer()
                centerContent
                Spacer()
            }
        }
        .preferredColorScheme(isDarkMode ? .dark : .light)
    }

    private var header: some View {
        ZStack {
            HStack {
                HStack(spacing: 8) {
                    WindowControlButton(color: Color(red: 1.0, green: 95/255, blue: 87/255), action: .close, ringColor: palette.ringColor)
                    WindowControlButton(color: Color(red: 254/255, green: 188/255, blue: 46/255), action: .miniaturize, ringColor: palette.ringColor)
                    WindowControlButton(color: Color(red: 40/255, green: 200/255, blue: 64/255), action: .zoom, ringColor: palette.ringColor)
                }
                Spacer()
            }
            .padding(.horizontal, 12)

            Text("verso.")
                .font(.custom("IBM Plex Sans SemiBold", size: 13))
                .foregroundStyle(palette.ink)
        }
        .frame(height: 38)
        .frame(maxWidth: .infinity)
    }

    private var centerContent: some View {
        VStack(spacing: 32) {
            VStack(spacing: 16) {
                Text("Welcome")
                    .font(.custom("IBM Plex Sans SemiBold", size: 34))
                    .foregroundStyle(palette.ink)

                Text("Please sign in by clicking the button below. You'll be redirected back to verso once you're done.")
                    .font(.custom("IBM Plex Sans", size: 13))
                    .foregroundStyle(palette.inkDim)
                    .multilineTextAlignment(.center)
                    .lineSpacing(3)
                    .frame(width: Self.contentWidth)
            }

            Button(action: signIn) {
                Text("Sign in")
                    .font(.custom("IBM Plex Sans Medium", size: 14))
                    .foregroundStyle(palette.primaryText)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 12)
                    .background(
                        isButtonHovered ? palette.primaryFillHover : palette.primaryFill,
                        in: RoundedRectangle(cornerRadius: 8, style: .continuous)
                    )
            }
            .buttonStyle(.plain)
            .frame(width: Self.contentWidth)
            .onHover { isButtonHovered = $0 }

            if let errorMessage {
                Text(errorMessage)
                    .font(.custom("IBM Plex Sans", size: 12))
                    .foregroundStyle(palette.danger)
                    .multilineTextAlignment(.center)
                    .frame(width: Self.contentWidth)
            }
        }
    }

    private func signIn() {
        errorMessage = nil

        guard let frontendURL, let url = Self.freshPrivySessionURL(from: frontendURL) else {
            errorMessage = "Sign-in URL is not configured."
            return
        }

        NSWorkspace.shared.open(url)
    }

    private static func freshPrivySessionURL(from raw: String) -> URL? {
        guard var components = URLComponents(string: raw) else { return nil }
        var queryItems = components.queryItems ?? []
        queryItems.removeAll { $0.name == "fresh_privy_session" }
        queryItems.removeAll { $0.name == "redirect_uri" }
        queryItems.append(URLQueryItem(name: "fresh_privy_session", value: "1"))
        queryItems.append(URLQueryItem(name: "redirect_uri", value: Self.callbackRedirectURI))
        components.queryItems = queryItems
        return components.url
    }

    private static var callbackRedirectURI: String {
        #if DEBUG
        return "verso-dev://auth/callback"
        #else
        return "verso://auth/callback"
        #endif
    }
}
