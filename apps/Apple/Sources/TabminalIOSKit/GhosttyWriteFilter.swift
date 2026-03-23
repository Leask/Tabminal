import Foundation

struct GhosttyWriteFilter: Sendable {
    private var pending = Data()

    mutating func reset() {
        pending.removeAll(keepingCapacity: true)
    }

    mutating func consume(_ data: Data) -> Data {
        guard !data.isEmpty else {
            return Data()
        }

        pending.append(data)
        let bytes = [UInt8](pending)
        var output: [UInt8] = []
        output.reserveCapacity(bytes.count)

        var index = 0
        scan: while index < bytes.count {
            let byte = bytes[index]
            if byte != 0x1B {
                output.append(byte)
                index += 1
                continue
            }

            guard index + 1 < bytes.count else {
                break
            }

            switch bytes[index + 1] {
            case 0x5B:
                guard let end = csiSequenceEnd(
                    in: bytes,
                    start: index + 2
                ) else {
                    break scan
                }

                let final = bytes[end]
                let body = bytes[(index + 2)..<end]
                if !shouldDropCSI(body: body, final: final) {
                    output.append(contentsOf: bytes[index...end])
                }
                index = end + 1

            case 0x5D:
                guard let end = oscSequenceEnd(
                    in: bytes,
                    start: index + 2
                ) else {
                    break scan
                }

                let payloadEnd = oscPayloadEnd(in: bytes, end: end)
                let payload = bytes[(index + 2)..<payloadEnd]
                if !shouldDropOSC(payload: payload) {
                    output.append(contentsOf: bytes[index...end])
                }
                index = end + 1

            default:
                output.append(byte)
                index += 1
            }
        }

        if index < bytes.count {
            pending = Data(bytes[index...])
        } else {
            pending.removeAll(keepingCapacity: true)
        }

        return Data(output)
    }

    private func csiSequenceEnd(
        in bytes: [UInt8],
        start: Int
    ) -> Int? {
        var cursor = start
        while cursor < bytes.count {
            let value = bytes[cursor]
            if value >= 0x40 && value <= 0x7E {
                return cursor
            }
            cursor += 1
        }

        return nil
    }

    private func oscSequenceEnd(
        in bytes: [UInt8],
        start: Int
    ) -> Int? {
        var cursor = start
        while cursor < bytes.count {
            let value = bytes[cursor]
            if value == 0x07 {
                return cursor
            }

            if value == 0x1B {
                guard cursor + 1 < bytes.count else {
                    return nil
                }

                if bytes[cursor + 1] == 0x5C {
                    return cursor + 1
                }
            }

            cursor += 1
        }

        return nil
    }

    private func oscPayloadEnd(
        in bytes: [UInt8],
        end: Int
    ) -> Int {
        if end > 0 && bytes[end] == 0x5C && bytes[end - 1] == 0x1B {
            return end - 1
        }

        return end
    }

    private func shouldDropCSI(
        body: ArraySlice<UInt8>,
        final: UInt8
    ) -> Bool {
        guard final == 0x52 || final == 0x6E else {
            return false
        }

        guard !body.isEmpty else {
            return false
        }

        return body.allSatisfy { byte in
            (byte >= 0x30 && byte <= 0x39)
                || byte == 0x3B
                || byte == 0x3F
        }
    }

    private func shouldDropOSC(payload: ArraySlice<UInt8>) -> Bool {
        guard let separator = payload.firstIndex(of: 0x3B) else {
            return false
        }

        let command = payload[..<separator]
        switch String(decoding: command, as: UTF8.self) {
        case "4", "10", "11":
            return true
        default:
            return false
        }
    }
}
