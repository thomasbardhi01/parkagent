import SwiftUI

/// Marker for map annotations. `.car` is where the car rests; `.zone` marks a
/// candidate meter zone.
struct MapPin: View {
    enum Kind {
        case car
        case zone

        var systemImage: String {
            switch self {
            case .car: "car.fill"
            case .zone: "parkingsign"
            }
        }

        var fill: Color {
            switch self {
            case .car: .ink
            case .zone: .slate
            }
        }
    }

    let kind: Kind

    var body: some View {
        VStack(spacing: -1) {
            ZStack {
                Circle()
                    .fill(kind.fill)
                    .frame(width: 36, height: 36)
                    .overlay(Circle().strokeBorder(Color.white, lineWidth: 2))
                Image(systemName: kind.systemImage)
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(Color.white)
            }
            Triangle()
                .fill(kind.fill)
                .frame(width: 12, height: 7)
        }
        .shadow(color: .black.opacity(0.25), radius: 3, y: 2)
    }

    private struct Triangle: Shape {
        func path(in rect: CGRect) -> Path {
            var path = Path()
            path.move(to: CGPoint(x: rect.minX, y: rect.minY))
            path.addLine(to: CGPoint(x: rect.maxX, y: rect.minY))
            path.addLine(to: CGPoint(x: rect.midX, y: rect.maxY))
            path.closeSubpath()
            return path
        }
    }
}

#Preview("MapPin") {
    HStack(spacing: Spacing.double) {
        MapPin(kind: .car)
        MapPin(kind: .zone)
    }
    .padding(Spacing.double)
    .background(Color.sky.opacity(0.4))
}
