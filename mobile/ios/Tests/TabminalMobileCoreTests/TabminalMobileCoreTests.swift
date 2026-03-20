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

@Test
func clusterPayloadDecodesBackendBaseUrlKey() throws {
    let json = """
    {
        "servers": [
            {
                "id": "elm",
                "baseUrl": "https://tabminal-elm.example.com",
                "host": "Elm",
                "token": "abc"
            }
        ]
    }
    """

    let payload = try JSONDecoder().decode(
        TabminalClusterPayload.self,
        from: Data(json.utf8)
    )

    #expect(payload.servers.count == 1)
    #expect(
        payload.servers[0].baseURL.absoluteString
            == "https://tabminal-elm.example.com/"
    )
}

@Test
func heartbeatDecodesEmptyEditorStateFromBackend() throws {
    let json = """
    {
        "sessions": [
            {
                "id": "session-1",
                "createdAt": "1970-01-01T00:00:00.000Z",
                "shell": "/bin/bash",
                "initialCwd": "/Users/test",
                "title": "bash",
                "cwd": "/Users/test",
                "env": "USER=test",
                "cols": 80,
                "rows": 24,
                "editorState": {}
            }
        ],
        "system": {
            "hostname": "flora"
        },
        "runtime": {
            "bootId": "123"
        }
    }
    """

    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .iso8601
    let response = try decoder.decode(
        TabminalHeartbeatResponse.self,
        from: Data(json.utf8)
    )

    #expect(response.sessions.count == 1)
    #expect(response.sessions[0].editorState?.isVisible == false)
    #expect(response.sessions[0].editorState?.root == "")
    #expect(response.sessions[0].editorState?.openFiles == [])
}

@Test
func accessLoginResponseDetectionMatchesSubHostHtmlRedirects() throws {
    let endpoint = TabminalServerEndpoint(
        id: "elm",
        baseURL: try #require(
            URL(string: "https://tabminal-elm.example.com")
        )
    )
    let requestURL = try #require(
        URL(string: "https://tabminal-elm.example.com/api/heartbeat")
    )
    let responseURL = try #require(
        URL(string: "https://tabminal-elm.example.com/cdn-cgi/access/login")
    )
    let request = URLRequest(url: requestURL)
    let response = try #require(
        HTTPURLResponse(
            url: responseURL,
            statusCode: 200,
            httpVersion: nil,
            headerFields: ["Content-Type": "text/html"]
        )
    )
    let body = Data("<html>Cloudflare Access sign in</html>".utf8)

    #expect(
        TabminalAPIClient.isLikelyAccessLoginResponse(
            request: request,
            response: response,
            body: body,
            server: endpoint
        )
    )
}

@Test
func accessLoginResponseDetectionSkipsPrimaryHost() throws {
    let endpoint = TabminalServerEndpoint(
        id: "main",
        baseURL: try #require(
            URL(string: "https://tabminal.example.com")
        ),
        isPrimary: true
    )
    let requestURL = try #require(
        URL(string: "https://tabminal.example.com/api/heartbeat")
    )
    let request = URLRequest(url: requestURL)
    let response = try #require(
        HTTPURLResponse(
            url: requestURL,
            statusCode: 200,
            httpVersion: nil,
            headerFields: ["Content-Type": "text/html"]
        )
    )
    let body = Data("<html>Cloudflare Access sign in</html>".utf8)

    #expect(
        !TabminalAPIClient.isLikelyAccessLoginResponse(
            request: request,
            response: response,
            body: body,
            server: endpoint
        )
    )
}
