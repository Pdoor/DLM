from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


API_KEY = "bc26fe4be7c24d33a08f2af63c47a0cc"
BUNGIE_BASE_URL = "https://www.bungie.net"


class DlmHandler(SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith("/bungie/Platform/") or self.path.startswith("/bungie/common/"):
            self.proxy_bungie(self.path[len("/bungie"):])
            return
        super().do_GET()

    def proxy_bungie(self, path):
        url = BUNGIE_BASE_URL + path
        request = Request(url, headers={"X-API-Key": API_KEY, "User-Agent": "Destiny-Lore-Masters-WebApp"})

        try:
            with urlopen(request, timeout=30) as response:
                body = response.read()
                self.send_response(response.status)
                self.send_header("Content-Type", response.headers.get("Content-Type", "application/json"))
                self.send_header("Cache-Control", "no-store")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(body)
        except HTTPError as error:
            body = error.read()
            self.send_response(error.code)
            self.send_header("Content-Type", error.headers.get("Content-Type", "application/json"))
            self.end_headers()
            self.wfile.write(body)
        except URLError as error:
            message = f'{{"ErrorCode":500,"Message":"Proxy locale: {error.reason}"}}'.encode("utf-8")
            self.send_response(502)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(message)


if __name__ == "__main__":
    port = 8080
    server = ThreadingHTTPServer(("127.0.0.1", port), DlmHandler)
    print(f"Destiny Lore Masters locale: http://localhost:{port}")
    server.serve_forever()
