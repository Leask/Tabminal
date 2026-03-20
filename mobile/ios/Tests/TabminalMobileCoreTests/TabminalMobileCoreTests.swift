import Foundation
import Testing
@testable import TabminalMobileCore

@Test
func sessionKeyRoundTripMatchesWebClientFormat() throws {
    let key = TabminalSessionKey(serverID: "main", sessionID: "abc-123")

    #expect(key.rawValue == "main:abc-123")
    #expect(TabminalSessionKey(rawValue: key.rawValue) == key)
}

@Test
func baseURLNormalizationDropsQueryAndTrailingSlash() throws {
    let endpoint = TabminalServerEndpoint(
        id: "main",
        baseURL: try #require(
            URL(string: "https://tabminal.example.com/?foo=bar")
        )
    )

    #expect(endpoint.baseURL.absoluteString == "https://tabminal.example.com/")
}

@Test
func websocketURLMatchesServerContract() throws {
    let endpoint = TabminalServerEndpoint(
        id: "elm",
        baseURL: try #require(
            URL(string: "https://tabminal-elm.example.com")
        ),
        token: "abc"
    )

    let url = endpoint.webSocketURL(sessionID: "session-1")

    #expect(
        url.absoluteString
            == "wss://tabminal-elm.example.com/ws/session-1?token=abc"
    )
}

@Test
func passwordHasherMatchesServerSha256Format() {
    let hash = TabminalPasswordHasher.sha256Hex("abc")

    #expect(
        hash
            == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    )
}
