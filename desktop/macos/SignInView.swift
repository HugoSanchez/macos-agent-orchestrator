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
    let inputFill: Color
    let inputStroke: Color
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
        inputFill: Color(red: 38/255, green: 40/255, blue: 43/255),    // #26282B paper-2
        inputStroke: Color.white.opacity(0.10),                        // line
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
        inputFill: Color(red: 251/255, green: 249/255, blue: 242/255), // #FBF9F2 warm cream
        inputStroke: Color(red: 50/255, green: 48/255, blue: 40/255).opacity(0.11), // line
        primaryFill: Color(red: 17/255, green: 17/255, blue: 17/255),  // #111 primary-btn-bg
        primaryFillHover: Color.black,                                 // primary-btn-bg-hover
        primaryText: Color.white,                                      // primary-btn-text
        danger: Color(red: 192/255, green: 57/255, blue: 43/255)       // #C0392B danger
    )
}

struct SignInView: View {
    @ObservedObject var managedSessionStore: ManagedSessionStore
    @AppStorage("isDarkMode") private var isDarkMode = true
    @State private var email = ""
    @State private var code = ""
    @State private var codeWasSent = false
    @State private var isSubmitting = false
    @State private var errorMessage: String?
    @State private var isButtonHovered = false
    @FocusState private var focusedField: Field?

    private static let contentWidth: CGFloat = 300

    private enum Field {
        case email
        case code
    }

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
        .onAppear { focusedField = codeWasSent ? .code : .email }
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

                Text(codeWasSent
                    ? "Enter the six-digit code we sent to \(email.trimmingCharacters(in: .whitespacesAndNewlines))."
                    : "Sign in with a one-time code sent to your email.")
                    .font(.custom("IBM Plex Sans", size: 13))
                    .foregroundStyle(palette.inkDim)
                    .multilineTextAlignment(.center)
                    .lineSpacing(3)
                    .frame(width: Self.contentWidth)
            }

            if codeWasSent {
                codeEntryField
            } else {
                TextField("you@example.com", text: $email)
                    .textContentType(.emailAddress)
                    .textFieldStyle(.plain)
                    .font(.custom("IBM Plex Sans", size: 14))
                    .foregroundStyle(palette.ink)
                    .padding(.horizontal, 12)
                    .frame(width: Self.contentWidth, height: 40)
                    .background(
                        palette.inputFill,
                        in: RoundedRectangle(cornerRadius: 8, style: .continuous)
                    )
                    .overlay {
                        RoundedRectangle(cornerRadius: 8, style: .continuous)
                            .stroke(palette.inputStroke, lineWidth: 1)
                    }
                    .focused($focusedField, equals: .email)
                    .onSubmit(submit)
            }

            Button(action: submit) {
                HStack(spacing: 8) {
                    if isSubmitting {
                        ProgressView()
                            .controlSize(.small)
                    }
                    Text(codeWasSent ? "Verify code" : "Send code")
                }
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
            .disabled(isSubmitting || !canSubmit)
            .opacity(canSubmit ? 1 : 0.95)
            .onHover { isButtonHovered = $0 }

            if codeWasSent {
                Button("Use a different email") {
                    codeWasSent = false
                    code = ""
                    errorMessage = nil
                    focusedField = .email
                }
                .buttonStyle(.plain)
                .font(.custom("IBM Plex Sans", size: 12))
                .foregroundStyle(palette.ink2)
                .disabled(isSubmitting)
            }

            if let errorMessage {
                Text(errorMessage)
                    .font(.custom("IBM Plex Sans", size: 12))
                    .foregroundStyle(palette.danger)
                    .multilineTextAlignment(.center)
                    .frame(width: Self.contentWidth)
            }
        }
    }

    private var codeEntryField: some View {
        ZStack {
            HStack(spacing: 8) {
                ForEach(0..<6, id: \.self) { index in
                    Text(codeDigit(at: index))
                        .font(.custom("IBM Plex Sans Medium", size: 17))
                        .foregroundStyle(palette.ink)
                        .frame(maxWidth: .infinity)
                        .frame(height: 44)
                        .background(
                            palette.inputFill,
                            in: RoundedRectangle(cornerRadius: 8, style: .continuous)
                        )
                        .overlay {
                            RoundedRectangle(cornerRadius: 8, style: .continuous)
                                .stroke(
                                    isActiveCodeSlot(index)
                                        ? palette.ink2.opacity(0.58)
                                        : palette.inputStroke,
                                    lineWidth: isActiveCodeSlot(index) ? 1.25 : 1
                                )
                        }
                }
            }
            .accessibilityHidden(true)

            // One real field powers all six visual cells. Keeping a single
            // editor makes typing, backspace, system one-time-code autofill,
            // and pasting a complete code work without per-cell bookkeeping.
            TextField("Six-digit code", text: $code)
                .textContentType(.oneTimeCode)
                .textFieldStyle(.plain)
                .focused($focusedField, equals: .code)
                .opacity(0.01)
                .frame(width: Self.contentWidth, height: 44)
                .onChange(of: code) { _, newValue in
                    let normalized = String(newValue.filter(\.isNumber).prefix(6))
                    if normalized != newValue {
                        code = normalized
                    }
                }
                .onSubmit(submit)
                .accessibilityLabel("Six-digit verification code")
        }
        .frame(width: Self.contentWidth, height: 44)
        .contentShape(Rectangle())
        .onTapGesture { focusedField = .code }
    }

    private func codeDigit(at index: Int) -> String {
        guard index < code.count else { return "" }
        return String(code[code.index(code.startIndex, offsetBy: index)])
    }

    private func isActiveCodeSlot(_ index: Int) -> Bool {
        focusedField == .code && index == min(code.count, 5)
    }

    private var canSubmit: Bool {
        if codeWasSent {
            return code.allSatisfy(\.isNumber) && code.count == 6
        }
        let normalized = email.trimmingCharacters(in: .whitespacesAndNewlines)
        return normalized.contains("@") && normalized.count <= 320
    }

    private func submit() {
        guard canSubmit, !isSubmitting else { return }
        errorMessage = nil
        isSubmitting = true
        Task {
            defer { isSubmitting = false }
            do {
                if codeWasSent {
                    try await managedSessionStore.verifyMagicCode(email: email, code: code)
                } else {
                    try await managedSessionStore.requestMagicCode(email: email)
                    codeWasSent = true
                    focusedField = .code
                }
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }
}
