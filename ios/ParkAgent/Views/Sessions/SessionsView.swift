import MapKit
import SwiftUI

struct SessionsView: View {
    @Environment(AppModel.self) private var model
    @Namespace private var sessionZoom

    var body: some View {
        NavigationStack {
            Group {
                if model.history.isEmpty && model.activeSession == nil {
                    EmptyStateView(
                        icon: "clock.arrow.circlepath",
                        title: "No sessions yet",
                        message: "Once ParkAgent pays a meter, the session shows up here."
                    )
                } else {
                    list
                }
            }
            .tabScreen()
            .navigationTitle("Sessions")
            .navigationDestination(for: SessionRecord.self) { record in
                SessionDetailView(record: record)
                    // The row grows into its detail (iOS 18+; plain push
                    // before that and under Reduce Motion).
                    .zoomDestination(id: record.id, in: sessionZoom)
            }
        }
    }

    private var list: some View {
        ScrollView {
            LazyVStack(spacing: Spacing.half) {
                if let session = model.activeSession {
                    SessionRow(
                        street: session.zoneLabel,
                        zoneNumber: session.zoneNumber,
                        date: "Until \(Format.clockTime(session.expiresAt))",
                        amountUsd: session.amountUsd,
                        status: .active
                    )
                }
                ForEach(model.history) { record in
                    NavigationLink(value: record) {
                        SessionRow(
                            street: record.zoneLabel,
                            zoneNumber: record.zoneNumber,
                            date: Format.dayAndTime(record.startedAt),
                            amountUsd: record.amountUsd,
                            status: record.status
                        )
                    }
                    .buttonStyle(.pressable)
                    .zoomSource(id: record.id, in: sessionZoom)
                    .accessibilityIdentifier("sessions.row.\(record.zoneNumber)")
                }
            }
            .padding(Spacing.unit)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("sessions.view")
        }
    }
}

struct SessionDetailView: View {
    let record: SessionRecord

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Spacing.unit) {
                if let lat = record.lat, let lng = record.lng {
                    let coordinate = CLLocationCoordinate2D(latitude: lat, longitude: lng)
                    Map(initialPosition: .region(MKCoordinateRegion(
                        center: coordinate,
                        span: MKCoordinateSpan(latitudeDelta: 0.004, longitudeDelta: 0.004)
                    ))) {
                        Annotation("Parked here", coordinate: coordinate) {
                            MapPin(kind: .car)
                        }
                    }
                    .mapStyle(.standard(pointsOfInterest: .excludingAll))
                    .frame(height: 180)
                    .clipShape(RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
                    .allowsHitTesting(false)
                    .accessibilityIdentifier("sessionDetail.map")
                }

                VStack(alignment: .leading, spacing: Spacing.half) {
                    HStack {
                        Text(record.zoneLabel)
                            .font(.bodyTextSemibold)
                            .foregroundStyle(Color.textPrimary)
                        Spacer()
                        StatusPill(status: record.status)
                    }
                    Text(Format.money(record.amountUsd))
                        .font(.numeral)
                        .foregroundStyle(Color.textPrimary)
                }
                .padding(Spacing.unit)
                .frame(maxWidth: .infinity, alignment: .leading)
                .cardStyle()

                VStack(spacing: 0) {
                    detailRow("Started", Format.dayAndTime(record.startedAt))
                    if let ended = record.endedAt {
                        Divider()
                        detailRow("Ended", Format.dayAndTime(ended))
                        Divider()
                        detailRow("Duration", Format.minutes(Int(ended.timeIntervalSince(record.startedAt) / 60)))
                    }
                    Divider()
                    detailRow("Session", record.id)
                }
                .background(Color.surface)
                .clipShape(RoundedRectangle(cornerRadius: Radius.button, style: .continuous))
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("sessionDetail.receipt")
            }
            .padding(Spacing.unit)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("sessionDetail.view")
        }
        .background(Color.appBackground)
        .navigationTitle("Session")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func detailRow(_ label: String, _ value: String) -> some View {
        HStack {
            Text(label)
                .font(.secondaryText)
                .foregroundStyle(Color.textSecondary)
            Spacer()
            Text(value)
                .font(.secondaryText)
                .foregroundStyle(Color.textPrimary)
                .lineLimit(1)
                .truncationMode(.middle)
        }
        .padding(Spacing.unit)
    }
}

#Preview {
    SessionsView()
        .environment(AppModel())
}
