import MapKit
import SwiftUI

struct HomeView: View {
    @Environment(AppModel.self) private var model
    @Environment(AuthModel.self) private var auth
    @Environment(PermissionsManager.self) private var permissions
    @Namespace private var sessionZoom
    /// The Account sheet — everything the Settings tab used to hold.
    @State private var accountPresented = false
    /// Set once from the car, else the user's location (followed), else the
    /// detected city — the map never opens on a hardcoded city.
    @State private var camera: MapCameraPosition = .automatic
    /// Initial centering runs once per Home lifetime. `.task` re-runs on
    /// every tab return and navigation pop, which snapped the map back to
    /// the car after the user had moved it.
    @State private var didCenter = false
    /// Keep the camera on the phone as it moves, until the user pans or
    /// zooms (MapKit marks that `positionedByUser`); locate-me turns it
    /// back on. Live API only — the mock has no real location. It used to
    /// be a flag that only changed the icon; the camera never moved.
    ///
    /// Not MapKit's `.userLocation` position: that follows, but at its own
    /// ~2 km zoom, above `curbZoomSpan`, so no curb line ever drew while
    /// following (seen in the simulator).
    @State private var following = false
    /// Live map window, for the curb-layer fetch and the zoom gate.
    @State private var visibleRegion: MKCoordinateRegion?
    @State private var curbZones: [NearbyZone] = []
    @State private var selectedZone: NearbyZone?
    /// The center the loaded curb layer was fetched for, so panning a little
    /// doesn't refetch on every frame.
    @State private var curbFetchedAt: CLLocationCoordinate2D?
    @State private var curbTruncated = false

    /// Curb lines only make sense at street zoom; above this the whole city
    /// would be one smear of lines (and the fetch radius is capped at 400 m
    /// server-side anyway).
    private static let curbZoomSpan: CLLocationDegrees = 0.012
    /// Refetch once the map has moved this far from the last fetch.
    private static let curbRefetchDistanceM: Double = 150

    var body: some View {
        @Bindable var model = model
        NavigationStack {
            mapLayer
            .overlay(alignment: .top) {
                VStack(spacing: Spacing.half) {
                    statusChip
                    if model.liveAPIUnavailable {
                        ErrorBanner(
                            icon: "exclamationmark.triangle.fill",
                            title: "Not connected to ParkAgent",
                            message: "The live API isn't configured — add API_BASE_URL to Config.xcconfig and reinstall."
                        )
                    } else if model.policyLoadFailed {
                        ErrorBanner(
                            title: "Can't reach the ParkAgent server",
                            message: "Nothing loads until the connection is back.",
                            retryTitle: "Retry",
                            retry: { Task { await model.loadPolicy() } }
                        )
                    }
                    if permissions.locationDenied {
                        PermissionBanner()
                    }
                    if permissions.motionDenied {
                        PermissionBanner(
                            icon: "figure.walk.circle",
                            title: "Motion & Fitness is off",
                            message: "Park detection loses its driving-to-walking signal without it."
                        )
                    }
                }
                .padding(.top, Spacing.half)
                .padding(.horizontal, Spacing.unit)
            }
            .overlay(alignment: .trailing) { locateMeButton }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                // No living wash on this screen: behind a map it reads as
                // haze over the streets. Non-map surfaces keep it.
                BottomSheet { sheetContent }
            }
            .navigationDestination(for: String.self) { sessionId in
                ActiveSessionView()
                    .zoomDestination(id: sessionId, in: sessionZoom)
            }
            .task {
                guard !didCenter else { return }
                didCenter = true
                await centerCamera()
            }
            .task(id: following) { await followPhone() }
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        accountPresented = true
                    } label: {
                        AccountAvatar(name: auth.user?.name ?? "")
                    }
                    .accessibilityIdentifier("home.accountButton")
                    .accessibilityLabel("Account")
                }
            }
            .sheet(isPresented: $accountPresented) {
                AccountSheetView()
            }
        }
    }

    // MARK: - Map

    private var mapLayer: some View {
        MapReader { proxy in
            Map(position: $camera) {
                UserAnnotation()
                // Curb lines under the pins: paying-now coral, free-now green.
                ForEach(curbZones) { zone in
                    ForEach(Array(zone.polylines.enumerated()), id: \.offset) { _, line in
                        MapPolyline(coordinates: line)
                            .stroke(
                                zone.enforcedNow ? Color.actionCoral : Color.success,
                                style: StrokeStyle(
                                    lineWidth: zone.zoneId == selectedZone?.zoneId ? 7 : 3.5,
                                    lineCap: .round
                                )
                            )
                    }
                }
                if let car = model.carCoordinate {
                    Annotation("Your car", coordinate: car) {
                        MapPin(kind: .car)
                    }
                }
            }
            .mapStyle(.standard(pointsOfInterest: .excludingAll))
            // Scale and compass top-trailing; the status chip owns the top
            // leading corner, so nothing overlaps it.
            .mapControls {
                MapScaleView()
                MapCompass()
            }
            .onChange(of: camera) { _, position in
                // Any pan or pinch is the user taking the wheel.
                if position.positionedByUser { following = false }
            }
            .onMapCameraChange(frequency: .onEnd) { context in
                visibleRegion = context.region
                Task { await refreshCurbLayer(for: context.region) }
            }
            .onTapGesture { point in
                guard let coordinate = proxy.convert(point, from: .local) else { return }
                selectZone(at: coordinate)
            }
        }
    }

    /// Re-centers on the user and resumes following.
    private var locateMeButton: some View {
        Button {
            Task { await locateMe() }
        } label: {
            Image(systemName: following ? "location.fill" : "location")
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(following ? Color.actionCoralLink : Color.textPrimary)
                .frame(width: 44, height: 44)
                .background(Color.surface, in: Circle())
                .shadow(color: .black.opacity(0.15), radius: 4, y: 1)
        }
        .padding(.trailing, Spacing.unit)
        .accessibilityLabel(following ? "Following your location" : "Center on your location")
        .accessibilityIdentifier("home.locateMeButton")
    }

    /// The car's spot if it's parked; else follow the phone, falling back to
    /// the detected city while there is no fix (or no permission) — never a
    /// fixed city constant.
    private func centerCamera() async {
        var known = model.carCoordinate
        if let car = known {
            camera = .region(MKCoordinateRegion(center: car, span: Self.streetSpan))
        } else if model.useMockAPI {
            // The mock has no real location: it answers from the city
            // scenario so the simulator and UI tests are deterministic.
            let phone = MockFixtures.currentCoordinate()
            known = phone
            camera = .region(MKCoordinateRegion(center: phone, span: Self.streetSpan))
        } else {
            // The city until a fix arrives (or when location is off).
            camera = cityPosition
            known = await OneShotLocation.request()
            if let phone = known {
                camera = .region(MKCoordinateRegion(center: phone, span: Self.streetSpan))
                following = true
            }
        }

        // Name the city in the chip at launch, without waiting for the
        // first park to tell us where we are. Every launch, not only a
        // fresh install: the detected city persists, so someone who drove
        // from one covered city to the other was shown the old one.
        if let known {
            _ = await model.detectCity(lat: known.latitude, lng: known.longitude)
        }
    }

    /// The detected (or chosen) city at street zoom — what the map shows
    /// until a location fix arrives.
    private var cityPosition: MapCameraPosition {
        .region(MKCoordinateRegion(
            center: CityCatalog.center(of: model.effectiveCity) ?? CityCatalog.fallbackCenter,
            span: Self.streetSpan
        ))
    }

    private static let streetSpan = MKCoordinateSpan(latitudeDelta: 0.006, longitudeDelta: 0.006)

    /// Locate-me: back to the user, following again.
    private func locateMe() async {
        let phone = model.useMockAPI ? MockFixtures.currentCoordinate() : await OneShotLocation.request()
        guard let phone else { return }
        withAnimation(Motion.settle) {
            camera = .region(MKCoordinateRegion(center: phone, span: Self.streetSpan))
        }
        following = !model.useMockAPI
    }

    /// Moving this far from the map's center re-centers it while following;
    /// less is GPS jitter not worth a camera move.
    private static let followSlackM: Double = 15

    /// While following, keep the camera on the phone at the current zoom.
    /// The task is keyed on `following`, so turning it off (or leaving
    /// Home) cancels it and stops the location updates.
    private func followPhone() async {
        guard following, !model.useMockAPI else { return }
        do {
            for try await update in CLLocationUpdate.liveUpdates() {
                guard following else { return }
                guard let phone = update.location?.coordinate else { continue }
                if let shown = visibleRegion, distance(shown.center, phone) < Self.followSlackM {
                    continue
                }
                withAnimation(Motion.settle) {
                    camera = .region(MKCoordinateRegion(
                        center: phone,
                        span: visibleRegion?.span ?? Self.streetSpan
                    ))
                }
            }
        } catch {
            // Updates ended (cancelled, or location went away): nothing to follow.
        }
    }

    /// Tapping the city chip recenters the same way.
    private func recenterOnCity() {
        let center = CityCatalog.center(of: model.effectiveCity) ?? CityCatalog.fallbackCenter
        following = false
        withAnimation(Motion.settle) {
            camera = .region(MKCoordinateRegion(
                center: center,
                span: MKCoordinateSpan(latitudeDelta: 0.05, longitudeDelta: 0.05)
            ))
        }
    }

    // MARK: - Curb layer

    /// Loads the curb lines for the visible window, at street zoom only. The
    /// server caps the radius at 400 m, so this asks for what fits the
    /// window within that.
    private func refreshCurbLayer(for region: MKCoordinateRegion) async {
        guard region.span.latitudeDelta <= Self.curbZoomSpan else {
            // Zoomed out: drop the lines rather than draw a smear of them.
            curbZones = []
            curbFetchedAt = nil
            selectedZone = nil
            return
        }
        if let last = curbFetchedAt, distance(last, region.center) < Self.curbRefetchDistanceM {
            return
        }
        // Claim the window before awaiting: MapKit sends a burst of camera
        // changes at launch, and each one used to fire the same query.
        curbFetchedAt = region.center
        // Half the window's height in metres, clamped to the server's cap.
        let radius = min(400, max(120, region.span.latitudeDelta * 111_320 / 2))
        guard let response = try? await model.api.nearbyZones(
            lat: region.center.latitude,
            lng: region.center.longitude,
            radiusM: radius
        ) else {
            // Release the claim (if no newer fetch took it) so the next
            // camera change retries this window.
            if let claimed = curbFetchedAt, distance(claimed, region.center) < 1 { curbFetchedAt = nil }
            return
        }
        // Each camera change starts its own fetch; one for a window the
        // user has since left (or zoomed out of) must not paint over it.
        if let current = visibleRegion,
           current.span.latitudeDelta > Self.curbZoomSpan
            || distance(current.center, region.center) >= Self.curbRefetchDistanceM {
            return
        }
        curbZones = response.zones
        curbTruncated = response.truncated
        // A reloaded layer may not contain the tapped zone any more.
        if let selected = selectedZone, !response.zones.contains(where: { $0.zoneId == selected.zoneId }) {
            selectedZone = nil
        }
    }

    /// The tapped curb line: nearest line SEGMENT within a tolerance that
    /// scales with zoom, so a fat finger still lands on a thin line (see
    /// CurbHitTest for why segments, not vertices).
    private func selectZone(at coordinate: CLLocationCoordinate2D) {
        guard !curbZones.isEmpty else { return }
        let tolerance = max(25, (visibleRegion?.span.latitudeDelta ?? 0.006) * 111_320 * 0.04)
        let hit = CurbHitTest.nearestZone(to: coordinate, in: curbZones, toleranceM: tolerance)
        withAnimation(Motion.settle) {
            selectedZone = hit
        }
    }

    private func distance(_ a: CLLocationCoordinate2D, _ b: CLLocationCoordinate2D) -> Double {
        CLLocation(latitude: a.latitude, longitude: a.longitude)
            .distance(from: CLLocation(latitude: b.latitude, longitude: b.longitude))
    }

    private var statusChip: some View {
        // Tapping it recenters on the city — the "where am I looking?"
        // control right next to the "where am I?" label.
        Button {
            recenterOnCity()
        } label: {
            HStack(spacing: Spacing.half) {
                Circle()
                    // textSecondary, not steel: steel is under 3:1 against the
                    // light chip surface.
                    .fill(model.activeSession == nil ? Color.textSecondary : Color.success)
                    .frame(width: 8, height: 8)
                Text(chipText)
                    .font(.captionTextSemibold)
                    .foregroundStyle(Color.textPrimary)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, Spacing.half)
            .frame(minHeight: 44)
            .background(Color.surface)
            .clipShape(Capsule())
            .shadow(color: .black.opacity(0.1), radius: 4, y: 1)
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("home.statusChip")
        .accessibilityHint("Centers the map on your city")
    }

    private var chipText: String {
        let status: String
        if let session = model.activeSession {
            status = "Paid until \(Format.clockTime(session.expiresAt))"
        } else {
            status = "No active session"
        }
        // Multi-city state, always in view: which city's meters we'd pay.
        if let city = model.cityDisplayName {
            return "\(city) · \(status)"
        }
        return status
    }

    /// The tapped curb line's terms. Small, dismissible, and above the
    /// spend row so it reads as an answer to the tap.
    @ViewBuilder
    private func curbTermsCard(_ zone: NearbyZone) -> some View {
        VStack(alignment: .leading, spacing: Spacing.half) {
            HStack(spacing: Spacing.half) {
                Text(zone.street?.capitalized ?? "This block")
                    .font(.bodyTextSemibold)
                    .foregroundStyle(Color.textPrimary)
                TagPill(
                    label: zone.enforcedNow ? "Paying now" : "Free now",
                    color: zone.enforcedNow ? .actionCoralLink : .success
                )
                Spacer()
                Button {
                    withAnimation(Motion.settle) { selectedZone = nil }
                } label: {
                    Image(systemName: "xmark")
                        .font(.captionTextSemibold)
                        .foregroundStyle(Color.textSecondary)
                        .frame(width: 32, height: 32)
                }
                .accessibilityLabel("Dismiss zone details")
            }
            Text(curbTermsLine(zone))
                .font(.secondaryText)
                .foregroundStyle(Color.textSecondary)
                .accessibilityIdentifier("home.curbTerms")
            if !zone.providerZoneNumber.isEmpty {
                Text("Zone \(zone.providerZoneNumber)")
                    .font(.captionText)
                    .foregroundStyle(Color.textSecondary)
            }
        }
        .padding(Spacing.unit)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.surface)
        .clipShape(RoundedRectangle(cornerRadius: Radius.button, style: .continuous))
        .accessibilityIdentifier("home.curbTermsCard")
    }

    private func curbTermsLine(_ zone: NearbyZone) -> String {
        var parts = [Format.money(zone.rateFirstHourUsd) + "/hr"]
        if zone.rateAdditionalHourUsd != zone.rateFirstHourUsd {
            parts[0] = "\(Format.money(zone.rateFirstHourUsd)) first hour, then \(Format.money(zone.rateAdditionalHourUsd))/hr"
        }
        if let maxStay = zone.maxStayMinutes {
            parts.append("\(Format.minutes(maxStay)) max")
        }
        let today = zone.todayHours
            .map { "\($0.start)–\($0.end)" }
            .joined(separator: ", ")
        parts.append(today.isEmpty ? "not enforced today" : "today \(today)")
        return parts.joined(separator: " · ")
    }

    @ViewBuilder
    private var sheetContent: some View {
        VStack(alignment: .leading, spacing: Spacing.unit) {
            if let zone = selectedZone {
                curbTermsCard(zone)
                    .transition(.opacity)
            } else if curbTruncated && !curbZones.isEmpty {
                // Never let a capped layer read as "that's all the metered
                // street there is".
                Text("Showing the nearest metered blocks — zoom in for the rest.")
                    .font(.captionText)
                    .foregroundStyle(Color.textSecondary)
                    .accessibilityIdentifier("home.curbTruncatedNote")
            }

            spendRow

            Button {
                model.openAssistant()
            } label: {
                Label("Ask ParkAgent", systemImage: "bubble.left.and.text.bubble.right")
            }
            .buttonStyle(.secondary)
            .accessibilityIdentifier("home.askAssistantButton")

            if let day = model.activeItinerary {
                ItineraryDaySection(day: day)
            }

            if let session = model.activeSession {
                NavigationLink(value: session.sessionId) {
                    SessionRow(
                        street: session.zoneLabel,
                        zoneNumber: session.zoneNumber,
                        date: "Until \(Format.clockTime(session.expiresAt))",
                        amountUsd: session.amountUsd,
                        status: .active
                    )
                }
                .buttonStyle(.pressable)
                .zoomSource(id: session.sessionId, in: sessionZoom)
                .accessibilityIdentifier("home.activeSessionRow")
            }

            #if DEBUG
            // UI tests drive parks from here; a real user reaches "simulate"
            // only through the hidden Diagnostics screen.
            if LaunchOverrides.uiTesting && model.activeSession == nil {
                Button("Simulate park") {
                    Task { await model.simulatePark() }
                }
                .buttonStyle(.secondary)
                .accessibilityIdentifier("home.simulateParkButton")
            }
            #endif
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("home.view")
    }

    private var spendRow: some View {
        // The Wallet's numbers — the same spend the caps count.
        let spending = model.wallet.response?.spending
        let cap = spending?.dailyCapUsd ?? model.policyResponse?.policy.dailyCapUsd ?? 60
        let today = spending?.todayUsd ?? 0
        let fraction = cap > 0 ? today / cap : 0
        return VStack(alignment: .leading, spacing: Spacing.half) {
            HStack {
                Text("Today")
                    .font(.captionTextSemibold)
                    .foregroundStyle(Color.textSecondary)
                    .textCase(.uppercase)
                Spacer()
                Text("\(Format.money(today)) of \(Format.money(cap))")
                    .font(.secondaryText)
                    .monospacedDigit()
                    .foregroundStyle(Color.textPrimary)
            }
            ProgressBar(value: fraction, tint: fraction < 0.8 ? .actionCoral : .warningGold)
        }
    }
}

#Preview {
    HomeView()
        .environment(AppModel())
        .environment(PermissionsManager())
}
