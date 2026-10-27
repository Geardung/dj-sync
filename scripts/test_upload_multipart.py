import urllib.request, uuid

png = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489"
    "0000000d49444154789c6360f8cf00000201010018dd8db10000000049454e44ae426082"
)
boundary = "----t" + uuid.uuid4().hex
body = b""
body += (
    "--" + boundary
    + "\r\nContent-Disposition: form-data; name=\"file\"; filename=\"t.png\"\r\n"
    + "Content-Type: image/png\r\n\r\n"
).encode()
body += png + b"\r\n"
body += (
    "--" + boundary
    + "\r\nContent-Disposition: form-data; name=\"uploadedBy\"\r\n\r\ntest\r\n"
).encode()
body += ("--" + boundary + "--\r\n").encode()

req = urllib.request.Request(
    "http://localhost:3000/api/photos",
    data=body,
    headers={"Content-Type": "multipart/form-data; boundary=" + boundary},
    method="POST",
)
try:
    with urllib.request.urlopen(req, timeout=30) as r:
        print(r.status, r.read()[:400])
except Exception as e:
    print("ERR", e)
    if hasattr(e, "read"):
        print(e.read()[:400])
