import SwiftUI
import AppKit

private struct SidebarLoadIdentity: Hashable {
    let sidecarPort: Int?
    let appUserId: String?
    let sidecarUserId: String?
}

struct ContentView: View {
    @ObservedObject var sidecar: SidecarManager
    @ObservedObject var managedSessionStore: ManagedSessionStore
    @StateObject private var sidebarStore: SidebarStore
    @AppStorage("isDarkMode") private var isDarkMode = true
    @AppStorage("isLeftSidebarExpanded") private var isLeftSidebarExpanded = true
    @AppStorage("isRightSidebarExpanded") private var isRightSidebarExpanded = false
    @AppStorage("didApplyRightSidebarClosedDefault") private var didApplyRightSidebarClosedDefault = false
    @AppStorage("isConnectionsCatalogExpanded") private var isConnectionsCatalogExpanded = false
    @AppStorage("isConnectionsListExpanded") private var isConnectionsListExpanded = true
    @AppStorage("isSessionsListExpanded") private var isSessionsListExpanded = true
    @AppStorage("isSkillsListExpanded") private var isSkillsListExpanded = true
    @AppStorage("isSkillsCatalogExpanded") private var isSkillsCatalogExpanded = false
    @AppStorage("isCronsListExpanded") private var isCronsListExpanded = true
    @AppStorage("selectedChatSessionId") private var persistedSelectedSessionId = ""
    @State private var sidebarToast: SidebarToast?
    @State private var pendingCronOpen: CronOpenRequest?
    @State private var pendingSettingsOpen: SettingsOpenRequest?
    // One-shot signal that asks the WebView to drop whatever page it's
    // showing (settings / skill / cron) and return to the chat surface for
    // the current session. Fired when the user taps the *already-selected*
    // session in the leftbar — selection doesn't change, so there's no shell
    // state delta to clear the overlay, yet the user clearly wants to go back.
    @State private var pendingChatFocus: ChatFocusRequest?

    init(sidecar: SidecarManager, managedSessionStore: ManagedSessionStore) {
        self.sidecar = sidecar
        self.managedSessionStore = managedSessionStore
        _sidebarStore = StateObject(wrappedValue: SidebarStore { error, context in
            Telemetry.reportError(error, context: context)
        })
    }

    private var theme: ConductorThemePalette {
        isDarkMode ? ConductorThemes.dark : ConductorThemes.light
    }

    private var sidecarPort: Int? {
        if case .running(let port) = sidecar.state { return port }
        return nil
    }

    private var sidebarLoadIdentity: SidebarLoadIdentity {
        SidebarLoadIdentity(
            sidecarPort: sidecarPort,
            appUserId: managedSessionStore.currentSession?.userId,
            sidecarUserId: sidecar.managedSession?.userId
        )
    }

    private var leftSidebarWidth: CGFloat {
        isLeftSidebarExpanded ? 320 : 0
    }

    var body: some View {
        HSplitView {
            // Left sidebar
            VStack(spacing: 0) {
                if isLeftSidebarExpanded {
                    TopChromeControls(
                        isLeftSidebarExpanded: $isLeftSidebarExpanded,
                        iconColor: theme.footerIcon,
                        ringColor: theme.iconRing
                    )
                    .padding(.leading, 14)
                    .padding(.top, 14)
                    .padding(.bottom, 10)
                }

                if isLeftSidebarExpanded {
                    SessionSidebar(
                        theme: theme,
                        isDarkMode: isDarkMode,
                        sessions: sidebarStore.sessions,
                        selectedSessionId: sidebarStore.selectedSessionId,
                        streamingSessionIds: sidebarStore.streamingSessionIds,
                        unreadSessionIds: sidebarStore.unreadSessionIds,
                        isLoadingSessions: sidebarStore.isLoadingSessions,
                        isBootstrapping: !sidebarStore.hasLoadedInitialData,
                        sessionError: sidebarStore.sessionError,
                        sidecarReady: sidecarPort != nil,
                        connections: sidebarStore.connections,
                        customConnectors: sidebarStore.customConnectors,
                        skills: sidebarStore.skills,
                        crons: sidebarStore.crons,
                        isCatalogOpen: isConnectionsCatalogExpanded,
                        isSkillsCatalogOpen: isSkillsCatalogExpanded,
                        isConnectionsExpanded: $isConnectionsListExpanded,
                        isSessionsExpanded: $isSessionsListExpanded,
                        isSkillsExpanded: $isSkillsListExpanded,
                        isCronsExpanded: $isCronsListExpanded,
                        onCreateSession: {
                            Task { await sidebarStore.createSession() }
                        },
                        onArchiveSession: { sessionId in
                            Task {
                                if await sidebarStore.archiveSession(id: sessionId) {
                                    showSidebarToast("Session archived")
                                }
                            }
                        },
                        onRenameSession: { sessionId, title in
                            Task { await sidebarStore.renameSession(id: sessionId, title: title) }
                        },
                        onSelectSession: { sessionId in
                            selectSession(sessionId)
                        },
                        onToggleCatalog: {
                            isConnectionsCatalogExpanded.toggle()
                            if isConnectionsCatalogExpanded {
                                isSkillsCatalogExpanded = false
                            }
                        },
                        onToggleSkillsCatalog: {
                            isSkillsCatalogExpanded.toggle()
                            if isSkillsCatalogExpanded {
                                isConnectionsCatalogExpanded = false
                            }
                        },
                        onOpenCron: { cronId in
                            pendingCronOpen = CronOpenRequest(id: cronId, token: UUID())
                        },
                        onDeleteCron: { cronId in
                            Task { await sidebarStore.deleteCron(id: cronId) }
                        },
                        onDisconnectConnection: { connectedAccountId in
                            Task { await sidebarStore.disconnectConnection(id: connectedAccountId) }
                        },
                        onRetryCustomConnector: { connectorId in
                            Task {
                                if let authURL = await sidebarStore.retryCustomConnector(id: connectorId) {
                                    NSWorkspace.shared.open(authURL)
                                }
                            }
                        },
                        onDisconnectCustomConnector: { connectorId in
                            Task { await sidebarStore.disconnectCustomConnector(id: connectorId) }
                        }
                    )
                }

                Spacer(minLength: 0)

                if isLeftSidebarExpanded {
                    SidebarFooter(
                        isDarkMode: $isDarkMode,
                        sidecarState: sidecar.state,
                        theme: theme,
                        onOpenSettings: {
                            pendingSettingsOpen = SettingsOpenRequest(token: UUID())
                        }
                    )
                }
            }
            .background(
                ZStack {
                    SidebarVisualEffect(isDarkMode: isDarkMode)
                        .opacity(isDarkMode ? 0 : 1)

                    LinearGradient(
                        colors: [theme.sidebarTop, theme.sidebarBottom],
                        startPoint: .top,
                        endPoint: .bottom
                    )
                    .opacity(theme.sidebarTintOpacity)
                }
            )
            .overlay(alignment: .trailing) {
                Rectangle()
                    .fill(theme.verticalDivider)
                    .frame(width: isDarkMode ? 1 : 0.5)
                    .opacity(isLeftSidebarExpanded ? (isDarkMode ? 1 : 0.00) : 0)
            }
            .overlay(alignment: .bottom) {
                if let sidebarToast {
                    SidebarToastView(toast: sidebarToast, theme: theme, isDarkMode: isDarkMode)
                        .padding(.bottom, 52)
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                }
            }
            .frame(minWidth: leftSidebarWidth, idealWidth: leftSidebarWidth, maxWidth: leftSidebarWidth)
            .clipped()

            // Center (main content area). The chat WebView fills the full column
            // height so the catalog overlay (rendered inside the WebView) can
            // span the full window height like the left sidebar.
            ChatWebView(
                sidecarPort: sidecarPort,
                sidecarAuthToken: sidecar.authToken,
                draftApprovalToken: sidecar.draftApprovalToken,
                isDarkMode: isDarkMode,
                isCatalogOpen: isConnectionsCatalogExpanded,
                isSkillsCatalogOpen: isSkillsCatalogExpanded,
                pendingCronOpen: pendingCronOpen,
                pendingSettingsOpen: pendingSettingsOpen,
                pendingChatFocus: pendingChatFocus,
                shellState: ShellState(
                    sessions: sidebarStore.sessions,
                    selectedSessionId: sidebarStore.selectedSessionId
                ),
                onShellAction: handleShellAction
            )
            .overlay(alignment: .topLeading) {
                if !isLeftSidebarExpanded {
                    TopChromeControls(
                        isLeftSidebarExpanded: $isLeftSidebarExpanded,
                        iconColor: theme.footerIcon,
                        ringColor: theme.iconRing
                    )
                    .padding(.leading, 14)
                    .padding(.top, 14)
                }
            }
            .overlay(alignment: .topTrailing) {
                Button(action: { isRightSidebarExpanded.toggle() }) {
                    SidebarToggleIcon(side: .right, color: theme.footerIcon)
                        .frame(width: 18, height: 14)
                        .padding(3)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .padding(.trailing, 14)
                .padding(.top, 14)
            }
            .overlay(alignment: .trailing) {
                Rectangle()
                    .fill(theme.verticalDivider)
                    .frame(width: isRightSidebarExpanded ? theme.centerRightDividerThickness : 0)
            }
            .frame(minWidth: 400, idealWidth: 600)

            // Right panel (vertical split)
            VSplitView {
                // Top: file tree area
                theme.rightTop
                    .overlay(alignment: .bottom) {
                        Rectangle()
                            .fill(theme.horizontalDivider)
                            .frame(height: theme.rightDividerThickness)
                    }
                    .frame(minHeight: 120)

                // Bottom: tabbed area
                theme.rightBottom
                    .frame(minHeight: 120)
            }
            .overlay(alignment: .leading) {
                // Keep the center/right split in light mode almost invisible.
                Rectangle()
                    .fill(theme.rightTop)
                    .frame(width: 1)
                    .opacity(isRightSidebarExpanded ? (isDarkMode ? 0 : 0.92) : 0)
            }
            .frame(
                minWidth: isRightSidebarExpanded ? 300 : 0,
                idealWidth: isRightSidebarExpanded ? 380 : 0,
                maxWidth: isRightSidebarExpanded ? 500 : 0
            )
            .clipped()
        }
        .preferredColorScheme(isDarkMode ? .dark : .light)
        .ignoresSafeArea()
        .background(theme.mainCanvas)
        .clipShape(RoundedRectangle(cornerRadius: ConductorThemePalette.windowCornerRadius, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: ConductorThemePalette.windowCornerRadius, style: .continuous)
                .strokeBorder(theme.windowBorder, lineWidth: 1)
        }
        .onAppear {
            if !didApplyRightSidebarClosedDefault {
                isRightSidebarExpanded = false
                didApplyRightSidebarClosedDefault = true
            }
        }
        .task(id: sidebarLoadIdentity) {
            let appUserId = managedSessionStore.currentSession?.userId
            let sidecarOwnsCurrentAccount = sidecar.managedSession?.userId == appUserId
            sidebarStore.activate(
                baseURL: sidecarOwnsCurrentAccount ? sidecar.baseURL : nil,
                authToken: sidecarOwnsCurrentAccount ? sidecar.authToken : nil,
                accountId: appUserId
            )
            await sidebarStore.loadInitialData()
        }
        // Browser OAuth and Hermes tool registration complete outside the
        // native event bridge. Poll only while a connector is genuinely
        // waiting for auth or showing its instant cached connected state;
        // live registry status ends the loop.
        .task(id: sidebarStore.needsCustomConnectorRefresh) {
            guard sidebarStore.needsCustomConnectorRefresh else { return }
            while !Task.isCancelled {
                do {
                    try await Task.sleep(nanoseconds: 2_000_000_000)
                } catch {
                    return
                }
                await sidebarStore.refreshConnections()
            }
        }
        // Hermes runs scheduled routines outside the chat WebView, so there
        // is no shell action to announce their lifecycle. Its jobs endpoint
        // exposes the scheduler's authoritative `running` flag; polling this
        // local sidecar endpoint makes the same sidebar activity cue appear
        // for both scheduled and manually triggered runs.
        .task(id: sidecarPort) {
            guard sidecarPort != nil else { return }
            while !Task.isCancelled {
                do {
                    try await Task.sleep(for: .seconds(3))
                } catch {
                    return
                }
                await sidebarStore.refreshCrons()
            }
        }
        .onReceive(NSWorkspace.shared.notificationCenter.publisher(for: NSWorkspace.didWakeNotification)) { _ in
            // One-shot resync on wake so the sidebar reflects anything that
            // happened externally (e.g. a routine fired, a connection was
            // revoked from another device). Steady-state refresh is fully
            // event-driven via the chatBridge `*Changed` messages.
            Task {
                await sidebarStore.refreshSessions()
                await sidebarStore.refreshConnections()
                await sidebarStore.refreshSkills()
                await sidebarStore.refreshCrons()
            }
        }
        .onChange(of: managedSessionStore.latestEvent?.id) { _, _ in
            guard let event = managedSessionStore.latestEvent else { return }
            showSidebarToast(event.message)
        }
        .onChange(of: managedSessionStore.currentSession?.userId) { oldUserId, newUserId in
            guard oldUserId != newUserId else { return }
            sidebarStore.prepareForAccountChange(accountId: newUserId)
            clearShellNavigationForAccountChange()
        }
        .onChange(of: sidebarStore.selectedSessionId) { _, selectedSessionId in
            persistedSelectedSessionId = selectedSessionId ?? ""
        }
    }


    /// Single entry point for every product-level JS→Swift action.
    @MainActor
    private func handleShellAction(_ action: ShellAction) {
        switch action {
        case .selectSession(let id):
            sidebarStore.setSelectedSession(id)
            Task { await sidebarStore.refreshSessions(preferredSelection: id) }
        case .sessionMutated:
            Task { await sidebarStore.refreshSessions() }
        case .sessionStreaming(let id, let streaming):
            sidebarStore.setStreaming(streaming, sessionId: id)
        case .sessionUnread(let id, let unread):
            sidebarStore.setUnread(unread, sessionId: id)
        case .createSession:
            Task { await sidebarStore.createSession() }
        case .archiveSession(let id):
            Task {
                if await sidebarStore.archiveSession(id: id) {
                    showSidebarToast("Session archived")
                }
            }
        case .unarchiveSession(let id):
            Task { await sidebarStore.unarchiveSession(id: id) }
        case .renameSession(let id, let title):
            Task { await sidebarStore.renameSession(id: id, title: title) }
        case .cronsChanged:
            Task { await sidebarStore.refreshCrons() }
        case .connectionsChanged:
            Task { await sidebarStore.refreshConnections() }
        case .skillsChanged:
            Task { await sidebarStore.refreshSkills() }
        case .openExternalUrl(let rawURL):
            if let url = URL(string: rawURL) {
                NSWorkspace.shared.open(url)
            }
        case .signOut:
            managedSessionStore.clearSession()
        case .catalogClosed:
            isConnectionsCatalogExpanded = false
        case .skillsCatalogClosed:
            isSkillsCatalogExpanded = false
        }
    }

    @MainActor
    private func selectSession(_ sessionId: String) {
        guard sidebarStore.selectedSessionId != sessionId else {
            // Re-tapping the active session: selection is unchanged, so the
            // WebView won't see a shell-state delta to clear an open page.
            // Nudge it back to the chat surface explicitly.
            pendingChatFocus = ChatFocusRequest(token: UUID())
            return
        }
        if let session = sidebarStore.sessions.first(where: { $0.id == sessionId }),
           session.archivedAt != nil {
            Task { await sidebarStore.unarchiveSession(id: sessionId) }
            return
        }
        sidebarStore.setSelectedSession(sessionId)
    }

    @MainActor
    private func clearShellNavigationForAccountChange() {
        persistedSelectedSessionId = ""
        pendingCronOpen = nil
        pendingSettingsOpen = nil
        pendingChatFocus = nil
    }

    private func showSidebarToast(_ message: String) {
        let toast = SidebarToast(id: UUID(), message: message)
        sidebarToast = toast

        Task { @MainActor in
            try? await Task.sleep(for: .seconds(1.8))
            if sidebarToast?.id == toast.id {
                withAnimation(.easeInOut(duration: 0.18)) {
                    sidebarToast = nil
                }
            }
        }
    }
}

#if DEBUG
struct ContentView_Previews: PreviewProvider {
    static var previews: some View {
        ContentView(sidecar: SidecarManager(), managedSessionStore: ManagedSessionStore())
            .frame(width: 1200, height: 750)
            .preferredColorScheme(.dark)
    }
}
#endif
