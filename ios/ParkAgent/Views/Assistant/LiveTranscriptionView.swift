import SwiftUI
import UIKit

/// The live dictation panel above the assistant's input bar: a live
/// waveform and the elapsed time, the words as they're recognized (fading
/// in), and — after a moment's quiet — "Still listening", because a pause
/// no longer ends the dictation. Tap the mic or Send to finish.
struct LiveTranscriptionPanel: View {
    let speech: SpeechRecognizer
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.half) {
            HStack(spacing: Spacing.half) {
                MicPulseIndicator(level: speech.level)
                WaveformView(levels: speech.levels)
                    .frame(height: 24)
                    .accessibilityIdentifier("assistant.dictation.waveform")
                if let startedAt = speech.startedAt {
                    TimelineView(.periodic(from: startedAt, by: 1)) { context in
                        Text(Self.elapsed(from: startedAt, to: context.date))
                            .font(.captionTextSemibold)
                            .monospacedDigit()
                            .foregroundStyle(Color.textSecondary)
                            .accessibilityLabel("Listening for \(Self.elapsed(from: startedAt, to: context.date))")
                            .accessibilityIdentifier("assistant.dictation.elapsed")
                    }
                }
            }
            if speech.isPausing {
                Text("Still listening — tap the mic or Send to finish")
                    .font(.captionText)
                    .foregroundStyle(Color.textSecondary)
                    .transition(.opacity)
                    .accessibilityIdentifier("assistant.dictation.pausing")
            }
            if !speech.words.isEmpty {
                FlowLayout(spacing: 5) {
                    ForEach(speech.words) { word in
                        Text(word.text)
                            .font(.bodyText)
                            .foregroundStyle(Color.textPrimary)
                            .transition(.opacity)
                    }
                }
                // Fade, not movement — safe under Reduce Motion too.
                .animation(.easeOut(duration: 0.25), value: speech.words)
                // The whole text in one element, for tests and VoiceOver.
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(speech.transcript)
                .accessibilityIdentifier("assistant.dictation.text")
            }
        }
        .animation(.easeOut(duration: 0.2), value: speech.isPausing)
        .padding(Spacing.unit)
        .frame(maxWidth: .infinity, alignment: .leading)
        .cardStyle()
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("assistant.liveTranscript")
    }

    /// "0:07", "1:12".
    static func elapsed(from start: Date, to now: Date) -> String {
        let seconds = max(0, Int(now.timeIntervalSince(start)))
        return String(format: "%d:%02d", seconds / 60, seconds % 60)
    }
}

/// The last few seconds of input level as bars, newest on the right.
struct WaveformView: View {
    let levels: [Double]

    var body: some View {
        GeometryReader { geometry in
            let count = max(levels.count, 1)
            let barWidth = max(2, geometry.size.width / CGFloat(count) - 2)
            HStack(alignment: .center, spacing: 2) {
                ForEach(Array(levels.enumerated()), id: \.offset) { _, level in
                    Capsule()
                        .fill(Color.actionCoral.opacity(0.35 + 0.65 * level))
                        .frame(width: barWidth, height: max(3, geometry.size.height * level))
                }
            }
            .frame(width: geometry.size.width, height: geometry.size.height, alignment: .trailing)
        }
        .animation(.linear(duration: 0.12), value: levels)
        .accessibilityHidden(true)
    }
}

/// The mic ring, scaled by voice level. Under Reduce Motion the ring holds
/// still and its opacity carries the level instead.
struct MicPulseIndicator: View {
    let level: Double
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ZStack {
            Circle()
                .fill(Color.actionCoral.opacity(reduceMotion ? 0.1 + 0.25 * level : 0.16))
                .frame(width: 30, height: 30)
                .scaleEffect(reduceMotion ? 1 : 1 + 0.5 * level)
            Image(systemName: "mic.fill")
                .font(.system(size: 13))
                .foregroundStyle(Color.actionCoralLink)
        }
        .frame(width: 44, height: 44)
        .animation(.easeOut(duration: 0.12), value: level)
        .accessibilityHidden(true)
    }
}

/// Dictation couldn't start: permission denied or recognition unavailable.
struct SpeechNoticeRow: View {
    let icon: String
    let message: String
    /// Present for the denied case — deep-links to the app's Settings page.
    var showsOpenSettings = false
    let dismiss: () -> Void

    var body: some View {
        HStack(spacing: Spacing.half) {
            Image(systemName: icon)
                .foregroundStyle(Color.warningGold)
            Text(message)
                .font(.captionText)
                .foregroundStyle(Color.textSecondary)
            Spacer()
            if showsOpenSettings {
                Button("Open Settings") {
                    if let url = URL(string: UIApplication.openSettingsURLString) {
                        UIApplication.shared.open(url)
                    }
                }
                .font(.captionTextSemibold)
                .foregroundStyle(Color.actionCoralLink)
                .frame(minHeight: 44)
            }
            Button {
                dismiss()
            } label: {
                Image(systemName: "xmark")
                    .font(.captionTextSemibold)
                    .foregroundStyle(Color.textSecondary)
                    .frame(width: 32, height: 44)
            }
            .accessibilityLabel("Dismiss")
        }
        .padding(.horizontal, Spacing.unit)
        .padding(.vertical, Spacing.quarter)
        .frame(maxWidth: .infinity, alignment: .leading)
        .cardStyle()
    }
}

/// Left-to-right wrapping layout for the transcript words, so each word is
/// its own view (and can fade in on its own) while reading like a sentence.
struct FlowLayout: Layout {
    var spacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        arrange(proposal: proposal, subviews: subviews).size
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let offsets = arrange(proposal: proposal, subviews: subviews).offsets
        for (subview, offset) in zip(subviews, offsets) {
            subview.place(
                at: CGPoint(x: bounds.minX + offset.x, y: bounds.minY + offset.y),
                proposal: .unspecified
            )
        }
    }

    private func arrange(
        proposal: ProposedViewSize, subviews: Subviews
    ) -> (offsets: [CGPoint], size: CGSize) {
        let maxWidth = proposal.width ?? .infinity
        var offsets: [CGPoint] = []
        var x: CGFloat = 0
        var y: CGFloat = 0
        var rowHeight: CGFloat = 0
        var widest: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x > 0, x + size.width > maxWidth {
                x = 0
                y += rowHeight + spacing
                rowHeight = 0
            }
            offsets.append(CGPoint(x: x, y: y))
            x += size.width + spacing
            widest = max(widest, x - spacing)
            rowHeight = max(rowHeight, size.height)
        }
        return (offsets, CGSize(width: widest, height: y + rowHeight))
    }
}

/// Three quiet dots while the assistant's reply streams in. Static under
/// Reduce Motion.
struct TypingIndicator: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        TimelineView(.animation(minimumInterval: 0.3, paused: reduceMotion)) { context in
            let step = Int(context.date.timeIntervalSinceReferenceDate / 0.3) % 3
            HStack(spacing: 4) {
                ForEach(0..<3, id: \.self) { index in
                    Circle()
                        .fill(Color.textSecondary)
                        .frame(width: 6, height: 6)
                        .opacity(reduceMotion || index == step ? 0.9 : 0.35)
                }
            }
            .animation(.easeInOut(duration: 0.25), value: step)
        }
        .accessibilityLabel("Thinking")
    }
}
