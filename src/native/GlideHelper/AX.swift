import ApplicationServices

/// Thin helpers over the AXUIElement C API.
enum AX {
    static func attr(_ el: AXUIElement, _ name: String) -> AnyObject? {
        var value: AnyObject?
        return AXUIElementCopyAttributeValue(el, name as CFString, &value) == .success ? value : nil
    }

    static func element(_ el: AXUIElement, _ name: String) -> AXUIElement? {
        guard let v = attr(el, name), CFGetTypeID(v) == AXUIElementGetTypeID() else { return nil }
        return (v as! AXUIElement)
    }

    static func children(_ el: AXUIElement) -> [AXUIElement] {
        (attr(el, kAXChildrenAttribute) as? [AXUIElement]) ?? []
    }

    /// Batched read; missing attributes come back as nil.
    static func attrs(_ el: AXUIElement, _ names: [String]) -> [AnyObject?] {
        var values: CFArray?
        guard AXUIElementCopyMultipleAttributeValues(el, names as CFArray, AXCopyMultipleAttributeOptions(rawValue: 0), &values) == .success,
              let array = values as? [AnyObject], array.count == names.count
        else { return names.map { attr(el, $0) } }
        return array.map { v in
            if CFGetTypeID(v) == AXValueGetTypeID(), AXValueGetType(v as! AXValue) == .axError { return nil }
            if v is NSNull { return nil }
            return v
        }
    }

    static func point(_ el: AXUIElement) -> CGPoint? {
        guard let v = attr(el, kAXPositionAttribute), CFGetTypeID(v) == AXValueGetTypeID() else { return nil }
        var p = CGPoint.zero
        return AXValueGetValue(v as! AXValue, .cgPoint, &p) ? p : nil
    }

    static func size(_ el: AXUIElement) -> CGSize? {
        guard let v = attr(el, kAXSizeAttribute), CFGetTypeID(v) == AXValueGetTypeID() else { return nil }
        var s = CGSize.zero
        return AXValueGetValue(v as! AXValue, .cgSize, &s) ? s : nil
    }

    static func frame(_ el: AXUIElement) -> CGRect? {
        guard let p = point(el), let s = size(el) else { return nil }
        return CGRect(origin: p, size: s)
    }

    static func setFrame(_ el: AXUIElement, _ rect: CGRect) {
        var size = rect.size
        var origin = rect.origin
        guard let sv = AXValueCreate(.cgSize, &size), let pv = AXValueCreate(.cgPoint, &origin) else { return }
        // size → position → size: apps clamp the size against the screen they are currently on.
        AXUIElementSetAttributeValue(el, kAXSizeAttribute as CFString, sv)
        AXUIElementSetAttributeValue(el, kAXPositionAttribute as CFString, pv)
        AXUIElementSetAttributeValue(el, kAXSizeAttribute as CFString, sv)
    }

    static func app(_ pid: pid_t, timeout: Float = 1.0) -> AXUIElement {
        let el = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(el, timeout)
        return el
    }
}
