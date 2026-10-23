import CoreLocation
import CoreWLAN
import GlideCore

/// Wi-Fi info (helper WiFi.swift). Since macOS 14 the SSID needs Location access; `requestLocation()` is
/// only called from PermissionService.request(.location).
@MainActor public final class CoreWLANService: NSObject, WiFiService, CLLocationManagerDelegate {
    private lazy var manager = CLLocationManager()
    private var waiter: CheckedContinuation<Void, Never>?

    public override init() { super.init() }

    public func locationStatus() -> String {
        switch manager.authorizationStatus {
        case .authorizedAlways: return "authorized"
        case .denied: return "denied"
        case .restricted: return "restricted"
        case .notDetermined: return "notDetermined"
        @unknown default: return "authorized"
        }
    }

    public func info() -> JSONValue {
        let iface = CWWiFiClient.shared().interface()
        let ssid = iface?.ssid()
        let poweredOn = iface?.powerOn() ?? false
        let associated = poweredOn && (iface?.wlanChannel() != nil || (iface?.rssiValue() ?? 0) != 0)
        let location = locationStatus()
        return [
            "ssid": ssid.map(JSONValue.string) ?? .null, "bssid": iface?.bssid().map(JSONValue.string) ?? .null,
            "interface": iface?.interfaceName.map(JSONValue.string) ?? .null, "poweredOn": .bool(poweredOn),
            "connected": .bool(ssid != nil || associated), "locationStatus": .string(location),
            "needsLocation": .bool(ssid == nil && location != "authorized" && associated),
        ]
    }

    /// Shows the Location prompt if never answered.
    public func requestLocation() async -> String {
        guard locationStatus() == "notDetermined" else { return locationStatus() }
        manager.delegate = self
        await withCheckedContinuation { cont in
            waiter = cont
            manager.requestWhenInUseAuthorization()
            manager.startUpdatingLocation()
        }
        manager.stopUpdatingLocation()
        return locationStatus()
    }

    public nonisolated func locationManagerDidChangeAuthorization(_ m: CLLocationManager) {
        let status = m.authorizationStatus
        Task { @MainActor in
            guard status != .notDetermined, let w = self.waiter else { return }
            self.waiter = nil
            w.resume()
        }
    }
}
