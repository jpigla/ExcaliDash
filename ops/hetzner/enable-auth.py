#!/usr/bin/env python3
"""Enable local authentication on a fresh, private ExcaliDash instance."""
import http.client
import json
import sys
from urllib.parse import urlsplit

origin = sys.argv[1]
port = int(sys.argv[2])
headers = {
    "Host": urlsplit(origin).netloc,
    "Origin": origin,
    "X-Forwarded-Proto": "https",
    "User-Agent": "ExcaliDash private setup",
}


def request(method, path, body=None):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    try:
        conn.request(method, "/api" + path, body, headers)
        response = conn.getresponse()
        data = response.read()
        if response.status != 200:
            raise SystemExit(f"{path}: HTTP {response.status}")
        return json.loads(data), response.getheader("Set-Cookie")
    finally:
        conn.close()


status, _ = request("GET", "/auth/status")
if status.get("authEnabled") is True:
    print("Authentication is enabled.")
    sys.exit(0)
if not status.get("authOnboardingRequired"):
    raise SystemExit("Expected an unconfigured instance.")
csrf, cookie = request("GET", "/csrf-token")
headers[csrf["header"]] = csrf["token"]
headers["Cookie"] = cookie.split(";", 1)[0]
headers["Content-Type"] = "application/json"
result, _ = request("POST", "/auth/onboarding-choice", '{"enableAuth":true}')
if result.get("authEnabled") is not True or not result.get("bootstrapRequired"):
    raise SystemExit("Authentication setup did not succeed.")
print("Authentication enabled. Administrator registration requires the one-time setup code.")
