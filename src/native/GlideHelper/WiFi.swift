import CoreLocation
import CoreWLAN

/// Wi-Fi network name. Since macOS 14 CoreWLAN returns nil for ssid/bssid unless the process has
/// Location Services access, so `info()` reports `needsLocation` and only `requestLocation()`
/// (an explicit button in Glide's settings) shows the Location prompt.
enum WiFi {
    /// Created lazily on the main thread (CLLocationManager wants a run loop); only read for its status.
    private static let statusManager = CLLocationManager()

    static func locationStatus() -> String {
        let status = onMain { statusManager.authorizationStatus }
        switch status {
        case .authorizedAlways: return "authorized" // .authorizedWhenInUse has the same raw value on macOS
        case .denied: return "denied"
        case .restricted: return "restricted"
        case .notDetermined: return "notDetermined"
        @unknown default: return "authorized"
        }
    }

    static func info() -> [String: Any] {
        let iface = CWWiFiClient.shared().interface()
        let ssid = iface?.ssid()
        let bssid = iface?.bssid()
        let location = locationStatus()
        let poweredOn = iface?.powerOn() ?? false
        // Associated but nameless means the OS is redacting the SSID for lack of Location access.
        let associated = poweredOn && (iface?.wlanChannel() != nil || iface?.rssiValue() ?? 0 != 0)
        return [
            "ssid": ssid ?? NSNull(),
            "bssid": bssid ?? NSNull(),
            "interface": iface?.interfaceName ?? NSNull(),
            "poweredOn": poweredOn,
            "connected": ssid != nil || associated,
            "locationStatus": location,
            "needsLocation": ssid == nil && location != "authorized" && associated,
        ]
    }

    private final class Waiter: NSObject, CLLocationManagerDelegate {
        let manager = CLLocationManager()
        let done = DispatchSemaphore(value: 0)
        private var signalled = false
        override init() {
            super.init()
            manager.delegate = self
        }
        func locationManagerDidChangeAuthorization(_ m: CLLocationManager) {
            guard m.authorizationStatus != .notDetermined, !signalled else { return }
            signalled = true
            m.stopUpdatingLocation()
            done.signal()
        }
        func locationManager(_ m: CLLocationManager, didFailWithError error: Error) {
            if m.authorizationStatus != .notDetermined { locationManagerDidChangeAuthorization(m) }
        }
        func locationManager(_ m: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
            m.stopUpdatingLocation()
        }
    }

    private static var waiter: Waiter?

    /// Shows the Location prompt if it was never answered; returns the resulting status.
    static func requestLocation() -> [String: Any] {
        if locationStatus() != "notDetermined" { return ["locationStatus": locationStatus()] }
        let w = onMain { () -> Waiter in
            let w = Waiter()
            waiter = w
            w.manager.requestWhenInUseAuthorization()
            // Some macOS versions only prompt once updates are requested; stopped as soon as it is answered.
            w.manager.startUpdatingLocation()
            return w
        }
        _ = w.done.wait(timeout: .now() + 120)
        onMain {
            w.manager.stopUpdatingLocation()
            waiter = nil
        }
        return ["locationStatus": locationStatus()]
    }
}
