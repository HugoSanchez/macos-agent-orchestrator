import SwiftUI
import AppKit
import Foundation

struct SessionSidebar: View {
    let theme: ConductorThemePalette
    let isDarkMode: Bool
    let sessions: [SidebarChatSession]
    let selectedSessionId: String?
    let streamingSessionIds: Set<String>
    let unreadSessionIds: Set<String>
    let isLoadingSessions: Bool
    let isBootstrapping: Bool
    let sessionError: String?
    let sidecarReady: Bool
    let connections: [SidebarConnection]
    let customConnectors: [SidebarCustomConnector]
    let skills: [SidebarSkill]
    let crons: [SidebarCron]
    let isCatalogOpen: Bool
    let isSkillsCatalogOpen: Bool
    @Binding var isConnectionsExpanded: Bool
    @Binding var isSessionsExpanded: Bool
    @Binding var isSkillsExpanded: Bool
    @Binding var isCronsExpanded: Bool
    let onCreateSession: () -> Void
    let onArchiveSession: (String) -> Void
    let onRenameSession: (String, String) -> Void
    let onSelectSession: (String) -> Void
    let onToggleCatalog: () -> Void
    let onToggleSkillsCatalog: () -> Void
    let onOpenCron: (String) -> Void
    let onDeleteCron: (String) -> Void
    let onDisconnectConnection: (String) -> Void
    let onRetryCustomConnector: (String) -> Void
    let onDisconnectCustomConnector: (String) -> Void

    @State private var renamingSessionId: String?
    @State private var draftTitle = ""

    private var secondaryText: Color {
        theme.inkDim
    }

    private var activeSessions: [SidebarChatSession] {
        sessions.filter { $0.archivedAt == nil }
    }

    private func cronTitle(_ cron: SidebarCron) -> String {
        let name = cron.name.trimmingCharacters(in: .whitespacesAndNewlines)
        if name.isEmpty { return "Scheduled routine" }
        if looksLikeScheduleExpression(name) {
            return humanizedSidebarSchedule(name) ?? "Scheduled routine"
        }
        return name
    }

    private func cronSubtitle(_ cron: SidebarCron) -> String? {
        if cron.state == "paused" { return "Disabled" }
        if let next = cron.nextRunAt, let date = parseISODate(next) {
            if date.timeIntervalSinceNow < 0 { return humanizedSidebarSchedule(cron.scheduleDisplay) }
            return "next " + relativeTime(date)
        }
        return humanizedSidebarSchedule(cron.scheduleDisplay)
    }

    private func humanizedSidebarSchedule(_ raw: String?) -> String? {
        guard let raw else { return nil }
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if value.isEmpty { return nil }

        if let duration = humanizedDurationSchedule(value) {
            return duration
        }

        let lowered = value.lowercased()
        if lowered.hasPrefix("every ") {
            return value
        }

        guard looksLikeScheduleExpression(value) else {
            return value
        }

        return humanizedCronExpression(value)
    }

    private func humanizedDurationSchedule(_ value: String) -> String? {
        let pattern = #"^(?:every\s+)?(\d+)\s*([mhd])$"#
        guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else {
            return nil
        }
        let range = NSRange(value.startIndex..<value.endIndex, in: value)
        guard let match = regex.firstMatch(in: value, range: range), match.numberOfRanges == 3,
              let amountRange = Range(match.range(at: 1), in: value),
              let unitRange = Range(match.range(at: 2), in: value),
              let amount = Int(value[amountRange]) else {
            return nil
        }
        let unit = String(value[unitRange]).lowercased()
        let label: String
        switch unit {
        case "m": label = amount == 1 ? "minute" : "minutes"
        case "h": label = amount == 1 ? "hour" : "hours"
        case "d": label = amount == 1 ? "day" : "days"
        default: return nil
        }
        return "Every \(amount) \(label)"
    }

    private func looksLikeScheduleExpression(_ value: String) -> Bool {
        let parts = value.split(whereSeparator: { $0 == " " || $0 == "\t" })
        guard parts.count == 5 || parts.count == 6 else { return false }
        let allowed = CharacterSet(charactersIn: "0123456789*,-/LW?#ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz")
        return parts.allSatisfy { part in
            !part.isEmpty && part.unicodeScalars.allSatisfy { allowed.contains($0) }
        }
    }

    private func humanizedCronExpression(_ value: String) -> String? {
        let parts = value.split(whereSeparator: { $0 == " " || $0 == "\t" }).map(String.init)
        let fields = parts.count == 6 ? Array(parts.dropFirst()) : parts
        guard fields.count == 5 else { return nil }
        let minute = fields[0]
        let hour = fields[1]
        let dayOfMonth = fields[2]
        let month = fields[3]
        let dayOfWeek = fields[4]

        if let amount = stepAmount(minute), hour == "*", dayOfMonth == "*", month == "*", dayOfWeek == "*" {
            return "Every \(amount) \(amount == 1 ? "minute" : "minutes")"
        }

        if minute == "0", let amount = stepAmount(hour), dayOfMonth == "*", month == "*", dayOfWeek == "*" {
            return "Every \(amount) \(amount == 1 ? "hour" : "hours")"
        }

        if minute == "0", dayOfMonth == "*", month == "*", isWeekdayCron(dayOfWeek) {
            if hour.contains("-") || hour == "*" || hour.contains("/") {
                return "Hourly weekdays"
            }
            if let hour = Int(hour) {
                return "Weekdays at \(formattedHour(hour))"
            }
        }

        if minute == "0", hour == "*", dayOfMonth == "*", month == "*" {
            return isWeekdayCron(dayOfWeek) ? "Hourly weekdays" : "Hourly"
        }

        if minute == "0", dayOfMonth == "*", month == "*", dayOfWeek == "*" || dayOfWeek == "?" {
            if let hour = Int(hour) {
                return "Daily at \(formattedHour(hour))"
            }
        }

        return nil
    }

    private func isWeekdayCron(_ value: String) -> Bool {
        let normalized = value.uppercased()
        return normalized == "1-5" || normalized == "MON-FRI"
    }

    private func stepAmount(_ value: String) -> Int? {
        guard value.hasPrefix("*/") else { return nil }
        return Int(value.dropFirst(2))
    }

    private func formattedHour(_ hour: Int) -> String {
        let normalized = ((hour % 24) + 24) % 24
        if normalized == 0 { return "12 AM" }
        if normalized < 12 { return "\(normalized) AM" }
        if normalized == 12 { return "12 PM" }
        return "\(normalized - 12) PM"
    }

    private func parseISODate(_ raw: String) -> Date? {
        let withFractional = ISO8601DateFormatter()
        withFractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = withFractional.date(from: raw) { return date }
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        return plain.date(from: raw)
    }

    private func relativeTime(_ date: Date) -> String {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .short
        return formatter.localizedString(for: date, relativeTo: Date())
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            if !isBootstrapping, let sessionError, !sessionError.isEmpty {
                Text(sessionError)
                    .font(ConductorType.caption)
                    .foregroundStyle(theme.danger)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(cardFill)
                    .overlay {
                        RoundedRectangle(cornerRadius: 8, style: .continuous)
                            .stroke(theme.inputStroke, lineWidth: 1)
                    }
                    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            }

            ScrollView(showsIndicators: false) {
                VStack(alignment: .leading, spacing: 26) {
                    VStack(alignment: .leading, spacing: 12) {
                        SidebarSectionHead(
                            label: "sessions",
                            isExpanded: $isSessionsExpanded,
                            dimText: secondaryText,
                            faintText: theme.inkFaint,
                            onAdd: onCreateSession,
                            addEnabled: sidecarReady,
                            addHelp: "New session"
                        )

                        if isSessionsExpanded {
                            SessionSidebarSection(
                                title: nil,
                                emptyText: "No sessions yet.",
                                isLoading: isBootstrapping || isLoadingSessions,
                                sessions: activeSessions,
                                selectedSessionId: selectedSessionId,
                                streamingSessionIds: streamingSessionIds,
                                unreadSessionIds: unreadSessionIds,
                                theme: theme,
                                isDarkMode: isDarkMode,
                                renamingSessionId: renamingSessionId,
                                draftTitle: draftTitle,
                                onDraftTitleChange: { draftTitle = $0 },
                                onSelectSession: onSelectSession,
                                onArchiveSession: onArchiveSession,
                                onBeginRename: beginRename,
                                onCommitRename: commitRename
                            )
                        }
                    }

                    VStack(alignment: .leading, spacing: 12) {
                        SidebarSectionHead(
                            label: "connections",
                            isExpanded: $isConnectionsExpanded,
                            dimText: secondaryText,
                            faintText: theme.inkFaint,
                            onAdd: onToggleCatalog,
                            addEnabled: sidecarReady,
                            addHelp: "Browse connections"
                        )

                        if isConnectionsExpanded {
                            VStack(alignment: .leading, spacing: 0) {
                                if connections.isEmpty && customConnectors.isEmpty {
                                    if isBootstrapping {
                                        SidebarLoadingRows(theme: theme, widths: [132, 104])
                                    } else {
                                        Text("No connected tools")
                                            .font(ConductorType.placeholder)
                                            .foregroundStyle(secondaryText)
                                    }
                                } else {
                                    ForEach(connections) { connection in
                                        SidebarConnectionRow(
                                            connection: connection,
                                            theme: theme,
                                            onDisconnect: { onDisconnectConnection(connection.connectedAccountId) }
                                        )
                                    }
                                    ForEach(customConnectors) { connector in
                                        SidebarCustomConnectorRow(
                                            connector: connector,
                                            theme: theme,
                                            onRetry: { onRetryCustomConnector(connector.id) },
                                            onDisconnect: { onDisconnectCustomConnector(connector.id) }
                                        )
                                    }
                                }
                            }
                        }
                    }

                    VStack(alignment: .leading, spacing: 12) {
                        SidebarSectionHead(
                            label: "skills",
                            isExpanded: $isSkillsExpanded,
                            dimText: secondaryText,
                            faintText: theme.inkFaint,
                            onAdd: onToggleSkillsCatalog,
                            addEnabled: sidecarReady,
                            addHelp: "Browse skills"
                        )

                        if isSkillsExpanded {
                            let pinnedSkills = skills.filter { $0.pinned }
                            VStack(alignment: .leading, spacing: 0) {
                                if pinnedSkills.isEmpty {
                                    if isBootstrapping {
                                        SidebarLoadingRows(theme: theme, widths: [116, 142])
                                    } else {
                                        Text("No skills pinned")
                                            .font(ConductorType.placeholder)
                                            .foregroundStyle(secondaryText)
                                    }
                                } else {
                                    ForEach(pinnedSkills) { skill in
                                        SidebarSkillRow(skill: skill, theme: theme)
                                    }
                                }
                            }
                        }
                    }

                    VStack(alignment: .leading, spacing: 12) {
                        SidebarSectionHead(
                            label: "routines",
                            isExpanded: $isCronsExpanded,
                            dimText: secondaryText,
                            faintText: theme.inkFaint,
                            onAdd: nil,
                            addEnabled: false,
                            addHelp: ""
                        )

                        if isCronsExpanded {
                            VStack(alignment: .leading, spacing: 0) {
                                if crons.isEmpty {
                                    if isBootstrapping {
                                        SidebarLoadingRows(theme: theme, widths: [138])
                                    } else {
                                        Text("No routines yet")
                                            .font(ConductorType.placeholder)
                                            .foregroundStyle(secondaryText)
                                    }
                                } else {
                                    ForEach(crons) { cron in
                                        SidebarCronRow(
                                            cron: cron,
                                            title: cronTitle(cron),
                                            subtitle: cronSubtitle(cron),
                                            theme: theme,
                                            onOpen: { onOpenCron(cron.id) },
                                            onDelete: { onDeleteCron(cron.id) }
                                        )
                                    }
                                }
                            }
                        }
                    }
                }
                .padding(.bottom, 8)
            }
        }
        .padding(.horizontal, 24)
        .padding(.top, 22)
    }

    private var cardFill: Color {
        theme.cardFill
    }

    private func beginRename(_ session: SidebarChatSession) {
        renamingSessionId = session.id
        draftTitle = session.title
    }

    private func commitRename(_ session: SidebarChatSession) {
        let trimmed = draftTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        renamingSessionId = nil
        // Hand focus back so the chat WebView can become first responder cleanly.
        NSApp.keyWindow?.makeFirstResponder(nil)
        NotificationCenter.default.post(name: .versoRestoreKeyboardFocus, object: nil)
        guard !trimmed.isEmpty, trimmed != session.title else { return }
        onRenameSession(session.id, trimmed)
    }
}

private struct SidebarLoadingRows: View {
    let theme: ConductorThemePalette
    let widths: [CGFloat]

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(Array(widths.enumerated()), id: \.offset) { _, width in
                RoundedRectangle(cornerRadius: 3, style: .continuous)
                    .fill(theme.inkFaint.opacity(0.28))
                    .frame(width: width, height: 8)
            }
        }
        .padding(.vertical, 7)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Loading")
    }
}

/// Lowercase, letterspaced section header (`sessions`, `connections (N)`, …)
/// with a subtle expand/collapse chevron and the mockup's plain-`+` add glyph.
/// Behaviors are unchanged — the label/chevron toggle `isExpanded`, the `+`
/// fires `onAdd` — only the presentation is editorial.
private struct SidebarSectionHead: View {
    let label: String
    @Binding var isExpanded: Bool
    let dimText: Color    // ink-dim (label)
    let faintText: Color  // ink-faint (chevron, add glyph)
    let onAdd: (() -> Void)?
    let addEnabled: Bool
    let addHelp: String

    var body: some View {
        HStack(spacing: 6) {
            Button(action: {
                withAnimation(.easeInOut(duration: 0.18)) {
                    isExpanded.toggle()
                }
            }) {
                HStack(spacing: 6) {
                    Text(label)
                        .font(ConductorType.sectionLabel)
                        .tracking(1.5)
                        .textCase(.lowercase)
                        .foregroundStyle(dimText)
                    Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
                        .font(ConductorType.disclosure)
                        .foregroundStyle(faintText)
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if let onAdd {
                SidebarSectionAddButton(
                    action: onAdd,
                    faintText: faintText,
                    dimText: dimText,
                    enabled: addEnabled,
                    help: addHelp
                )
            }
        }
    }
}

/// The mockup's `.sec-add`: a plain `+` text glyph, ink-faint, hover → ink-dim,
/// no background. Keeps the section's create/browse action wiring untouched.
private struct SidebarSectionAddButton: View {
    let action: () -> Void
    let faintText: Color
    let dimText: Color
    let enabled: Bool
    let help: String
    @State private var isHovered = false

    var body: some View {
        Button(action: action) {
            Text("+")
                .font(ConductorType.sectionLabel)
                .foregroundStyle(isHovered ? dimText : faintText)
                .frame(width: 18, height: 18)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .onHover { isHovered = $0 }
        .help(help)
    }
}

/// Pinned-skill row (`.row2`): name left (ink-2 → hover ink), `/slug` meta
/// right (ink-faint). Display-only, matching the previous behavior.
private struct SidebarSkillRow: View {
    let skill: SidebarSkill
    let theme: ConductorThemePalette
    @State private var isHovered = false

    var body: some View {
        HStack(spacing: 12) {
            Text(skill.name)
                .font(ConductorType.rowTitle)
                .foregroundStyle(isHovered ? theme.ink : theme.ink2)
                .lineLimit(1)

            Spacer(minLength: 0)

            Text("/" + skill.slug)
                .font(ConductorType.meta)
                .foregroundStyle(theme.inkFaint)
                .lineLimit(1)
        }
        .padding(.vertical, 7)
        .contentShape(Rectangle())
        .onHover { isHovered = $0 }
    }
}

private struct SessionSidebarSection: View {
    let title: String?
    let emptyText: String
    let isLoading: Bool
    let sessions: [SidebarChatSession]
    let selectedSessionId: String?
    let streamingSessionIds: Set<String>
    let unreadSessionIds: Set<String>
    let theme: ConductorThemePalette
    let isDarkMode: Bool
    let renamingSessionId: String?
    let draftTitle: String
    let onDraftTitleChange: (String) -> Void
    let onSelectSession: (String) -> Void
    let onArchiveSession: ((String) -> Void)?
    let onBeginRename: (SidebarChatSession) -> Void
    let onCommitRename: (SidebarChatSession) -> Void

    private var secondaryText: Color {
        theme.inkDim
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let title {
                Text(title)
                    .font(ConductorType.sectionLabel)
                    .tracking(1.5)
                    .textCase(.lowercase)
                    .foregroundStyle(secondaryText)
            }

            if sessions.isEmpty {
                if isLoading {
                    SidebarLoadingRows(theme: theme, widths: [146, 122, 158])
                } else {
                    Text(emptyText)
                        .font(ConductorType.placeholder)
                        .foregroundStyle(secondaryText)
                        .padding(.vertical, 6)
                }
            } else {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(sessions.enumerated()), id: \.element.id) { index, session in
                        SessionSidebarRow(
                            session: session,
                            displayIndex: index + 1,
                            isSelected: session.id == selectedSessionId,
                            isStreaming: streamingSessionIds.contains(session.id),
                            isUnread: unreadSessionIds.contains(session.id),
                            theme: theme,
                            isDarkMode: isDarkMode,
                            isRenaming: renamingSessionId == session.id,
                            draftTitle: draftTitle,
                            onDraftTitleChange: onDraftTitleChange,
                            onSelectSession: onSelectSession,
                            onArchiveSession: onArchiveSession,
                            onBeginRename: onBeginRename,
                            onCommitRename: onCommitRename
                        )
                    }
                }
            }
        }
    }
}

private struct SessionSidebarRow: View {
    let session: SidebarChatSession
    let displayIndex: Int
    let isSelected: Bool
    let isStreaming: Bool
    let isUnread: Bool
    let theme: ConductorThemePalette
    let isDarkMode: Bool
    let isRenaming: Bool
    let draftTitle: String
    let onDraftTitleChange: (String) -> Void
    let onSelectSession: (String) -> Void
    let onArchiveSession: ((String) -> Void)?
    let onBeginRename: (SidebarChatSession) -> Void
    let onCommitRename: (SidebarChatSession) -> Void
    @State private var isHovered = false

    // Editorial `.sess` ink scale: index → ink-faint (ink-dim when selected),
    // title → ink-2 (ink on hover, ink + SemiBold when selected). No fill.
    private var indexColor: Color {
        isSelected ? theme.inkDim : theme.inkFaint
    }

    private var titleColor: Color {
        if isSelected || isHovered { return theme.ink }
        return theme.ink2
    }

    private var titleFont: Font {
        isSelected ? ConductorType.rowTitleStrong : ConductorType.rowTitle
    }

    // ink-faint for trailing meta; ink-dim for the hover action glyphs.
    private var metaColor: Color { theme.inkFaint }
    private var actionColor: Color { theme.inkDim }

    var body: some View {
        // `.center` (not baseline) keeps the transient trailing controls
        // (equalizer / unread dot / hover actions) vertically stable; the
        // index and title share the same 13pt size so the visual result
        // matches the mockup's baseline grid.
        HStack(alignment: .center, spacing: 10) {
            Text(String(format: "%02d", displayIndex))
                .font(ConductorType.rowTitle)
                .foregroundStyle(indexColor)
                .frame(width: 22, alignment: .leading)

            if isRenaming {
                RenameTextField(
                    text: Binding(
                        get: { draftTitle },
                        set: onDraftTitleChange
                    ),
                    isDarkMode: isDarkMode,
                    onCommit: { onCommitRename(session) },
                    onCancel: {
                        onDraftTitleChange(session.title)
                        onCommitRename(session)
                    }
                )
                .frame(maxWidth: .infinity)
            } else {
                Text(session.title)
                    .font(titleFont)
                    .foregroundStyle(titleColor)
                    .lineLimit(1)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
                    .onTapGesture(count: 2) {
                        onBeginRename(session)
                    }
            }

            if isHovered, !isRenaming {
                HStack(spacing: 2) {
                    Button(action: { onBeginRename(session) }) {
                        Image(systemName: "pencil")
                            .font(ConductorType.rowActionIcon)
                            .foregroundStyle(actionColor)
                            .frame(width: 18, height: 16)
                    }
                    .buttonStyle(.plain)
                    .help("Rename session")

                    if let onArchiveSession, session.archivedAt == nil {
                        Button(action: { onArchiveSession(session.id) }) {
                            Image(systemName: "archivebox")
                                .font(ConductorType.rowActionIcon)
                                .foregroundStyle(actionColor)
                                .frame(width: 18, height: 16)
                        }
                        .buttonStyle(.plain)
                        .help("Archive session")
                    }
                }
            } else if isStreaming, !isRenaming {
                // "Agent is working" indicator. Takes the slot the timestamp
                // would otherwise occupy so the row height stays stable, and
                // yields back to the hover-actions when the user is reaching
                // for rename/archive.
                EqualizerBars(color: theme.green)
                    .help("Agent is working")
            } else if isUnread, !isRenaming {
                // Unread response. Same slot as the working indicator so
                // the row width stays constant. Only one of {streaming,
                // unread} can be true at a time (unread fires *after* a
                // stream ends).
                Circle()
                    .fill(theme.green)
                    .frame(width: 7, height: 7)
                    .help("New response")
            } else if !isRenaming {
                Text(sessionTimestampLabel(session))
                    .font(ConductorType.meta)
                    .foregroundStyle(metaColor)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 7)
        .contentShape(Rectangle())
        .onTapGesture {
            guard !isRenaming else { return }
            onSelectSession(session.id)
        }
        .onHover { isHovered = $0 }
    }
}

/// Three small vertical bars that independently bounce in height — the
/// canonical "audio is playing / agent is generating" cue you see in iOS
/// Music, the macOS menu-bar Now Playing indicator, etc.
///
/// Drives heights off a single `TimelineView(.animation)` clock with a
/// per-bar phase offset so the bars feel alive rather than marching in
/// lockstep. Cheap to render and doesn't depend on view-lifecycle quirks
/// the way a `.repeatForever` animation can.
private struct EqualizerBars: View {
    let color: Color
    private let barWidth: CGFloat = 2
    private let barSpacing: CGFloat = 2
    private let minHeight: CGFloat = 3
    private let maxHeight: CGFloat = 11
    /// Seconds per full bounce. Slightly faster than a heartbeat — fast
    /// enough to read as "active", slow enough to not feel jittery.
    private let period: Double = 0.85

    var body: some View {
        TimelineView(.animation) { context in
            let t = context.date.timeIntervalSinceReferenceDate
            HStack(alignment: .center, spacing: barSpacing) {
                bar(height: height(for: t, phase: 0.0))
                bar(height: height(for: t, phase: 0.33))
                bar(height: height(for: t, phase: 0.66))
            }
            .frame(height: maxHeight)
        }
    }

    private func bar(height: CGFloat) -> some View {
        Capsule(style: .continuous)
            .fill(color)
            .frame(width: barWidth, height: height)
    }

    /// Maps the current clock + per-bar phase offset to a height between
    /// `minHeight` and `maxHeight` using a sine wave. `phase` is fractional
    /// (0…1) — adding 1/3 between bars spreads them across the cycle.
    private func height(for time: TimeInterval, phase: Double) -> CGFloat {
        let cycle = (time / period + phase).truncatingRemainder(dividingBy: 1)
        // 0…1 → -1…1 → 0…1 with a sine curve (smoother ease than triangular).
        let eased = (sin(cycle * 2 * .pi) + 1) / 2
        return minHeight + (maxHeight - minHeight) * eased
    }
}

/// A quiet, continuously pulsing presence indicator for scheduled routines.
/// Its fixed trailing footprint preserves the sidebar's row alignment while
/// the breathing animation distinguishes active work from an unread dot.
private struct PulsingActivityDot: View {
    let color: Color
    private let period: Double = 1.2

    var body: some View {
        TimelineView(.animation) { context in
            let phase = (context.date.timeIntervalSinceReferenceDate / period)
                .truncatingRemainder(dividingBy: 1)
            let pulse = (sin(phase * 2 * .pi) + 1) / 2
            Circle()
                .fill(color)
                .frame(width: 7, height: 7)
                .opacity(0.5 + 0.5 * pulse)
                .scaleEffect(0.82 + 0.18 * pulse)
                .frame(width: 16, height: 16)
        }
    }
}

struct CronOpenRequest: Equatable {
    let id: String
    let token: UUID
}

struct SettingsOpenRequest: Equatable {
    let token: UUID
}

struct ChatFocusRequest: Equatable {
    let token: UUID
}

private struct SidebarCronRow: View {
    let cron: SidebarCron
    let title: String
    let subtitle: String?
    let theme: ConductorThemePalette
    let onOpen: () -> Void
    let onDelete: () -> Void

    @State private var isHovered = false
    @State private var confirmingDelete = false
    @State private var confirmResetTask: Task<Void, Never>?

    private var isDisabled: Bool {
        cron.state == "paused"
    }

    // `.row2`: name left (ink-2 → hover ink; ink-dim when paused), meta right
    // (the next-run / schedule subtitle, ink-faint).
    private var nameColor: Color {
        if isDisabled { return theme.inkDim }
        return isHovered ? theme.ink : theme.ink2
    }

    var body: some View {
        Button(action: onOpen) {
            HStack(spacing: 12) {
                Text(title)
                    .font(ConductorType.rowTitle)
                    .foregroundStyle(nameColor)
                    .lineLimit(1)

                Spacer(minLength: 0)

                if confirmingDelete {
                    Button(action: handleDeleteTap) {
                        Text("Confirm")
                            .font(ConductorType.caption)
                            .foregroundStyle(theme.dangerStrong)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .help("Click to delete")
                } else if isHovered {
                    Button(action: handleDeleteTap) {
                        Image(systemName: "archivebox")
                            .font(ConductorType.rowActionIconSmall)
                            .foregroundStyle(theme.inkDim)
                            .frame(width: 16, height: 16)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .help("Delete routine")
                } else if cron.running == true {
                    // Hermes marks a job active for its whole execution,
                    // including tool calls and result delivery. A pulse makes
                    // the routine's live state easy to scan without competing
                    // with the session equalizer or its schedule metadata.
                    PulsingActivityDot(color: theme.green)
                        .help("Routine is running")
                } else if let subtitle {
                    Text(subtitle)
                        .font(ConductorType.meta)
                        .foregroundStyle(theme.inkFaint)
                        .opacity(isDisabled ? 0.86 : 1)
                        .lineLimit(1)
                }
            }
            .padding(.vertical, 7)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering in
            isHovered = hovering
            if !hovering {
                resetConfirm()
            }
        }
    }

    private func handleDeleteTap() {
        if confirmingDelete {
            confirmResetTask?.cancel()
            confirmResetTask = nil
            confirmingDelete = false
            onDelete()
            return
        }
        confirmingDelete = true
        confirmResetTask?.cancel()
        confirmResetTask = Task { @MainActor in
            try? await Task.sleep(nanoseconds: 3_000_000_000)
            if !Task.isCancelled {
                confirmingDelete = false
            }
        }
    }

    private func resetConfirm() {
        confirmResetTask?.cancel()
        confirmResetTask = nil
        confirmingDelete = false
    }
}

private struct SidebarConnectionRow: View {
    let connection: SidebarConnection
    let theme: ConductorThemePalette
    let onDisconnect: () -> Void

    @State private var isHovered = false

    // A live connection reads ink-faint; anything not active/connected
    // (needs-auth, failed, expired, …) reads as the editorial orange warn.
    private var isHealthy: Bool {
        ["active", "connected"].contains(connection.status.lowercased())
    }

    private var statusColor: Color {
        isHealthy ? theme.inkFaint : theme.orange
    }

    var body: some View {
        HStack(spacing: 10) {
            ConnectionLogo(
                logoUrl: connection.logoUrl,
                toolkitName: connection.displayToolkitName,
                theme: theme
            )

            Text(connection.displayToolkitName)
                .font(ConductorType.rowTitle)
                .foregroundStyle(isHovered ? theme.ink : theme.ink2)

            Spacer(minLength: 0)

            if isHovered {
                SidebarDisconnectAction(
                    theme: theme,
                    help: "Revoke access and remove this connection",
                    onDisconnect: onDisconnect
                )
            } else if !isHealthy {
                Text(connection.status.capitalized)
                    .font(ConductorType.meta)
                    .foregroundStyle(statusColor)
            }
        }
        .padding(.vertical, 7)
        .contentShape(Rectangle())
        .onHover { hovering in
            isHovered = hovering
        }
    }
}

private struct SidebarCustomConnectorRow: View {
    let connector: SidebarCustomConnector
    let theme: ConductorThemePalette
    let onRetry: () -> Void
    let onDisconnect: () -> Void

    @State private var isHovered = false

    private var isHealthy: Bool {
        connector.status.state == "connected"
    }

    var body: some View {
        HStack(spacing: 10) {
            ConnectionLogo(
                logoUrl: connector.logoUrl,
                toolkitName: connector.displayName,
                theme: theme
            )

            VStack(alignment: .leading, spacing: 2) {
                Text(connector.displayName)
                    .font(ConductorType.rowTitle)
                    .foregroundStyle(isHovered ? theme.ink : theme.ink2)
                    .lineLimit(1)
                if !isHealthy {
                    Text(connector.statusText)
                        .font(ConductorType.meta)
                        .foregroundStyle(theme.orange)
                        .lineLimit(1)
                }
            }

            Spacer(minLength: 0)

            if isHovered {
                SidebarDisconnectAction(
                    theme: theme,
                    help: "Disconnect and remove this custom connector",
                    onDisconnect: onDisconnect
                )
            }
        }
        .padding(.vertical, 7)
        .contentShape(Rectangle())
        .onHover { hovering in
            isHovered = hovering
        }
        .contextMenu {
            if !isHealthy {
                Button("Sign in again", action: onRetry)
            }
            Button("Disconnect", role: .destructive, action: onDisconnect)
        }
    }
}

/// Mirrors the routine-delete interaction: the ordinary affordance uses the
/// standard row-action color, while only the explicit confirmation is red.
private struct SidebarDisconnectAction: View {
    let theme: ConductorThemePalette
    let help: String
    let onDisconnect: () -> Void

    @State private var confirmingDisconnect = false
    @State private var confirmResetTask: Task<Void, Never>?

    var body: some View {
        Button(action: handleTap) {
            Text(confirmingDisconnect ? "Confirm" : "Disconnect")
                .font(ConductorType.caption)
                .foregroundStyle(confirmingDisconnect ? theme.dangerStrong : theme.inkDim)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(confirmingDisconnect ? "Click to disconnect" : help)
        .onDisappear(perform: resetConfirm)
    }

    private func handleTap() {
        if confirmingDisconnect {
            resetConfirm()
            onDisconnect()
            return
        }

        confirmingDisconnect = true
        confirmResetTask?.cancel()
        confirmResetTask = Task { @MainActor in
            try? await Task.sleep(nanoseconds: 3_000_000_000)
            if !Task.isCancelled {
                confirmingDisconnect = false
            }
        }
    }

    private func resetConfirm() {
        confirmResetTask?.cancel()
        confirmResetTask = nil
        confirmingDisconnect = false
    }
}

private struct ConnectionLogo: View {
    let logoUrl: String?
    let toolkitName: String
    let theme: ConductorThemePalette

    @State private var image: NSImage?

    private static let size: CGFloat = 16

    var body: some View {
        Group {
            if let image {
                Image(nsImage: image)
                    .resizable()
                    .interpolation(.high)
                    .scaledToFit()
            } else {
                fallback
            }
        }
        .frame(width: Self.size, height: Self.size)
        .clipShape(RoundedRectangle(cornerRadius: 4, style: .continuous))
        .task(id: logoUrl) {
            await loadImage()
        }
    }

    private var fallback: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(theme.iconFallbackFill)
            Text(String(toolkitName.prefix(1)).uppercased())
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(theme.iconFallbackText)
        }
    }

    private func loadImage() async {
        image = nil
        guard let logoUrl, let url = URL(string: logoUrl) else {
            return
        }
        if let cached = ConnectionLogoCache.shared.image(for: logoUrl) {
            image = cached
            return
        }
        do {
            let (data, response) = try await URLSession.shared.data(from: url)
            guard !Task.isCancelled else { return }
            if let httpResponse = response as? HTTPURLResponse {
                guard (200..<300).contains(httpResponse.statusCode) else { return }
            }
            if let nsImage = NSImage(data: data) {
                ConnectionLogoCache.shared.set(nsImage, for: logoUrl)
                image = nsImage
            }
        } catch {
            // Fallback view will render on failure.
        }
    }
}

private final class ConnectionLogoCache {
    static let shared = ConnectionLogoCache()

    private let cache = NSCache<NSString, NSImage>()

    func image(for key: String) -> NSImage? {
        cache.object(forKey: key as NSString)
    }

    func set(_ image: NSImage, for key: String) {
        cache.setObject(image, forKey: key as NSString)
    }
}

struct SidebarToast: Identifiable, Equatable {
    let id: UUID
    let message: String
}

private func sessionTimestampLabel(_ session: SidebarChatSession) -> String {
    let source = session.archivedAt ?? session.updatedAt
    guard let date = sidebarISO8601WithFractional.date(from: source) ?? sidebarISO8601.date(from: source) else { return "" }
    return compactRelativeAge(from: date)
}

/// Single-unit compact age used in the `.sess` trailing column: `3s`, `3m`,
/// `26m`, `20h`, `3w`, then `mo` / `y` for older sessions.
private func compactRelativeAge(from date: Date) -> String {
    let seconds = Int(max(0, Date().timeIntervalSince(date)))
    if seconds < 60 { return "\(seconds)s" }
    let minutes = seconds / 60
    if minutes < 60 { return "\(minutes)m" }
    let hours = minutes / 60
    if hours < 24 { return "\(hours)h" }
    let days = hours / 24
    if days < 7 { return "\(days)d" }
    let weeks = days / 7
    if weeks < 5 { return "\(weeks)w" }
    let months = days / 30
    if days < 365 { return "\(months)mo" }
    return "\(days / 365)y"
}

private let sidebarISO8601WithFractional: ISO8601DateFormatter = {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter
}()

private let sidebarISO8601: ISO8601DateFormatter = {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime]
    return formatter
}()

struct SidebarToastView: View {
    let toast: SidebarToast
    let theme: ConductorThemePalette
    let isDarkMode: Bool

    var body: some View {
        Text(toast.message)
            .font(.system(size: 12, weight: .medium))
            .foregroundStyle(theme.toastText)
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(
                RoundedRectangle(cornerRadius: 999, style: .continuous)
                    .fill(theme.toastFill)
            )
            .overlay {
                RoundedRectangle(cornerRadius: 999, style: .continuous)
                    .stroke(theme.toastStroke, lineWidth: 1)
            }
            .shadow(color: .black.opacity(isDarkMode ? 0.18 : 0.08), radius: 12, y: 4)
    }
}

private struct RenameTextField: NSViewRepresentable {
    @Binding var text: String
    let isDarkMode: Bool
    let onCommit: () -> Void
    let onCancel: () -> Void

    func makeNSView(context: Context) -> NSTextField {
        let field = NSTextField(string: text)
        field.delegate = context.coordinator
        field.isBordered = false
        field.isBezeled = false
        field.drawsBackground = false
        field.focusRingType = .none
        // Blend with the row: transparent field, IBM Plex Sans 13 to match the
        // `.sess` title it replaces.
        field.font = NSFont(name: "IBM Plex Sans", size: 13) ?? .systemFont(ofSize: 13, weight: .regular)
        field.textColor = isDarkMode
            ? NSColor.white.withAlphaComponent(0.90)
            : NSColor(red: 52/255, green: 51/255, blue: 45/255, alpha: 1)  // #34332D ink
        field.cell?.usesSingleLineMode = true
        field.cell?.wraps = false
        field.cell?.isScrollable = true
        field.cell?.lineBreakMode = .byTruncatingTail

        // Take first responder once the view is in a window. The chat WKWebView
        // frequently holds first responder, so we have to claim it directly via
        // AppKit — SwiftUI's @FocusState doesn't always pre-empt the WebView.
        DispatchQueue.main.async {
            guard let window = field.window else { return }
            window.makeFirstResponder(field)
            field.currentEditor()?.selectAll(nil)
        }

        return field
    }

    func updateNSView(_ nsView: NSTextField, context: Context) {
        context.coordinator.parent = self
        if nsView.stringValue != text {
            nsView.stringValue = text
        }
        nsView.textColor = isDarkMode
            ? NSColor.white.withAlphaComponent(0.90)
            : NSColor(red: 52/255, green: 51/255, blue: 45/255, alpha: 1)  // #34332D ink
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(parent: self)
    }

    final class Coordinator: NSObject, NSTextFieldDelegate {
        var parent: RenameTextField
        private var hasResolved = false

        init(parent: RenameTextField) {
            self.parent = parent
        }

        func controlTextDidChange(_ notification: Notification) {
            guard let field = notification.object as? NSTextField else { return }
            parent.text = field.stringValue
        }

        func control(
            _ control: NSControl,
            textView: NSTextView,
            doCommandBy commandSelector: Selector
        ) -> Bool {
            if commandSelector == #selector(NSResponder.insertNewline(_:)) {
                resolve(commit: true)
                return true
            }
            if commandSelector == #selector(NSResponder.cancelOperation(_:)) {
                resolve(commit: false)
                return true
            }
            return false
        }

        func controlTextDidEndEditing(_ notification: Notification) {
            // Commit on losing focus too (clicking elsewhere).
            resolve(commit: true)
        }

        private func resolve(commit: Bool) {
            guard !hasResolved else { return }
            hasResolved = true
            if commit {
                parent.onCommit()
            } else {
                parent.onCancel()
            }
        }
    }
}

struct SidebarVisualEffect: NSViewRepresentable {
    let isDarkMode: Bool

    func makeNSView(context: Context) -> NSVisualEffectView {
        let view = NSVisualEffectView()
        view.state = .active
        view.blendingMode = .behindWindow
        view.material = isDarkMode ? .hudWindow : .sidebar
        return view
    }

    func updateNSView(_ nsView: NSVisualEffectView, context: Context) {
        nsView.state = .active
        nsView.blendingMode = .behindWindow
        nsView.material = isDarkMode ? .hudWindow : .sidebar
    }
}
