import os
import struct
import threading
import time
import unittest

from helpers import WsTestServer, wait_for  # noqa: F401  (helpers puts src on sys.path)

from ce_devterm import ws as wsmod
from ce_devterm.ws import ConnectionClosed, HandshakeError, WebSocket


class MaskingTest(unittest.TestCase):
    def test_mask_roundtrip_and_known_vector(self):
        # RFC 6455 5.7: "Hello" masked with 37 fa 21 3d
        key = bytes([0x37, 0xFA, 0x21, 0x3D])
        self.assertEqual(wsmod.mask_payload(key, b"Hello"), bytes([0x7F, 0x9F, 0x4D, 0x51, 0x58]))
        data = os.urandom(70001)
        self.assertEqual(wsmod.mask_payload(key, wsmod.mask_payload(key, data)), data)
        self.assertEqual(wsmod.mask_payload(key, b""), b"")

    def test_frame_lengths(self):
        f = wsmod.build_frame(wsmod.OP_TEXT, b"x" * 125, mask=False)
        self.assertEqual(f[1], 125)
        f = wsmod.build_frame(wsmod.OP_TEXT, b"x" * 126, mask=False)
        self.assertEqual(f[1], 126)
        self.assertEqual(struct.unpack(">H", f[2:4])[0], 126)
        f = wsmod.build_frame(wsmod.OP_BINARY, b"x" * 70000, mask=True, mask_key=b"abcd")
        self.assertEqual(f[1], 0x80 | 127)
        self.assertEqual(struct.unpack(">Q", f[2:10])[0], 70000)
        self.assertEqual(f[10:14], b"abcd")

    def test_accept_key_rfc_example(self):
        self.assertEqual(wsmod.accept_key("dGhlIHNhbXBsZSBub25jZQ=="), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=")


class ClientTest(unittest.TestCase):
    def serve(self, handler):
        srv = WsTestServer(handler)
        self.addCleanup(srv.stop)
        return srv

    def test_echo_masked_text_unicode_and_large(self):
        got = []

        def handler(c):
            c.handshake()
            while True:
                m = c.recv_message()
                if m is None:
                    c.close()
                    return
                got.append(m)
                c.send_frame(m[0], m[1].encode("utf-8") if isinstance(m[1], str) else m[1])

        srv = self.serve(handler)
        w = WebSocket.connect(srv.url, timeout=3)
        self.assertIn("GET /ws HTTP/1.1", srv.conns[0].request)
        w.send_text("hello · ✓ 全灯")
        self.assertEqual(w.recv(timeout=3), (wsmod.OP_TEXT, "hello · ✓ 全灯"))
        big = "x" * 70000
        w.send_text(big)
        self.assertEqual(w.recv(timeout=3)[1], big)
        w.send_binary(b"\x00\x01\x02")
        self.assertEqual(w.recv(timeout=3), (wsmod.OP_BINARY, b"\x00\x01\x02"))
        w.close()
        self.assertTrue(w.closed)

    def test_fragmented_message_with_interleaved_ping(self):
        pongs = []

        def handler(c):
            c.handshake()
            c.send_frame(wsmod.OP_TEXT, b"frag", fin=False)
            c.send_frame(wsmod.OP_PING, b"are you there")
            c.send_frame(wsmod.OP_CONT, b"ment", fin=False)
            c.send_frame(wsmod.OP_CONT, b"ed", fin=True)
            fin, op, payload, masked = c.recv_frame()
            pongs.append((op, payload, masked))
            time.sleep(0.2)

        srv = self.serve(handler)
        w = WebSocket.connect(srv.url, timeout=3)
        self.assertEqual(w.recv(timeout=3), (wsmod.OP_TEXT, "fragmented"))
        self.assertTrue(wait_for(lambda: pongs))
        self.assertEqual(pongs[0], (wsmod.OP_PONG, b"are you there", True))
        w.abort()

    def test_partial_frame_survives_timeouts(self):
        def handler(c):
            c.handshake()
            frame = wsmod.build_frame(wsmod.OP_TEXT, b'{"slow": true}', mask=False)
            c.send_raw(frame[:5])
            time.sleep(0.4)
            c.send_raw(frame[5:])
            time.sleep(0.3)

        srv = self.serve(handler)
        w = WebSocket.connect(srv.url, timeout=3)
        self.assertIsNone(w.recv(timeout=0.1))  # half a frame: nothing yet, nothing lost
        self.assertEqual(w.recv(timeout=3), (wsmod.OP_TEXT, '{"slow": true}'))
        w.abort()

    def test_server_close_code_is_reported_and_echoed(self):
        echoed = []

        def handler(c):
            c.handshake()
            c.close(4401, "unauthorized")
            fin, op, payload, masked = c.recv_frame()
            echoed.append((op, struct.unpack(">H", payload[:2])[0]))

        srv = self.serve(handler)
        w = WebSocket.connect(srv.url, timeout=3)
        with self.assertRaises(ConnectionClosed) as cm:
            w.recv(timeout=3)
        self.assertEqual(cm.exception.code, 4401)
        self.assertEqual(cm.exception.reason, "unauthorized")
        self.assertTrue(wait_for(lambda: echoed))
        self.assertEqual(echoed[0], (wsmod.OP_CLOSE, 4401))

    def test_peer_disappears(self):
        def handler(c):
            c.handshake()
            c.shutdown()

        srv = self.serve(handler)
        w = WebSocket.connect(srv.url, timeout=3)
        with self.assertRaises(ConnectionClosed) as cm:
            w.recv(timeout=3)
        self.assertEqual(cm.exception.code, 1006)

    def test_bad_accept_is_rejected(self):
        srv = self.serve(lambda c: c.handshake(accept="bm9wZQ=="))
        with self.assertRaises(HandshakeError):
            WebSocket.connect(srv.url, timeout=3)

    def test_http_error_is_rejected_with_status(self):
        srv = self.serve(lambda c: c.handshake(status_line="HTTP/1.1 404 Not Found"))
        with self.assertRaises(HandshakeError) as cm:
            WebSocket.connect(srv.url, timeout=3)
        self.assertEqual(cm.exception.status, 404)

    def test_reserved_bits_fail_the_connection(self):
        def handler(c):
            c.handshake()
            c.send_raw(bytes([0x80 | 0x40 | wsmod.OP_TEXT, 1]) + b"x")
            time.sleep(0.3)

        srv = self.serve(handler)
        w = WebSocket.connect(srv.url, timeout=3)
        with self.assertRaises(ConnectionClosed) as cm:
            w.recv(timeout=3)
        self.assertEqual(cm.exception.code, 1002)

    def test_concurrent_senders(self):
        received = []

        def handler(c):
            c.handshake()
            while len(received) < 200:
                m = c.recv_message()
                if m is None:
                    return
                received.append(m[1])

        srv = self.serve(handler)
        w = WebSocket.connect(srv.url, timeout=3)

        def burst(tag):
            for i in range(50):
                w.send_text("%s-%d-%s" % (tag, i, "y" * (i * 37)))

        ts = [threading.Thread(target=burst, args=(t,)) for t in "abcd"]
        for t in ts:
            t.start()
        for t in ts:
            t.join()
        self.assertTrue(wait_for(lambda: len(received) == 200, timeout=5))
        self.assertEqual(len(set(received)), 200)
        w.abort()


if __name__ == "__main__":
    unittest.main()
