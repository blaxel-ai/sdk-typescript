"""usage: python3 volume-holder.py <tree-dir> <files-to-hold> <scratch-dir>
Holds open files, deleted-but-open files and an fsync writer; a nonce in /tmp/holder.req gets /tmp/holder.<nonce>.json."""

import hashlib
import json
import os
import resource
import struct
import sys
import threading
import time
import zlib

TREE, HOLD, SCRATCH = sys.argv[1], int(sys.argv[2]), sys.argv[3]
RECORD = 4096
LARGE = bytes((i * 131) % 251 for i in range(1 << 20)) * 64  # 64 MiB, spans chunks


def unlinked(name, content):
    path = os.path.join(SCRATCH, name)
    with open(path, "wb") as f:
        f.write(content)
    fd = os.open(path, os.O_RDONLY)
    os.unlink(path)
    return fd


def read_all(fd, size):
    return os.pread(fd, size, 0)


os.makedirs(SCRATCH, exist_ok=True)
# The default soft limit (often 1024) is far below the files held here.
resource.setrlimit(resource.RLIMIT_NOFILE, (HOLD + 1024, max(HOLD + 1024, resource.getrlimit(resource.RLIMIT_NOFILE)[1])))

held = []
for dirpath, _, names in os.walk(TREE):
    for n in sorted(names):
        if len(held) == HOLD:
            break
        path = os.path.join(dirpath, n)
        held.append((os.open(path, os.O_RDONLY), os.path.relpath(path, TREE)))

small_fd = unlinked("small", b"small deleted file\n")
large_fd = unlinked("large", LARGE)
large_sha = hashlib.sha256(LARGE).hexdigest()
with open(os.path.join(SCRATCH, "linked"), "wb") as f:
    f.write(b"linked")
os.link(os.path.join(SCRATCH, "linked"), os.path.join(SCRATCH, "linked.2"))
linked_fd = os.open(os.path.join(SCRATCH, "linked"), os.O_RDONLY)
os.unlink(os.path.join(SCRATCH, "linked"))

synced = 0
records = open(os.path.join(SCRATCH, "records"), "wb")


def write_records():
    global synced
    seq = 0
    while True:
        seq += 1
        payload = bytes((seq + i) % 256 for i in range(RECORD - 12))
        records.write(struct.pack("<QI", seq, zlib.crc32(payload)) + payload)
        records.flush()
        os.fsync(records.fileno())
        synced = seq
        time.sleep(0.01)


def check():
    held_bad = sum(1 for fd, rel in held if read_all(fd, 256).decode() != rel)
    last = synced
    records_bad = 0
    with open(os.path.join(SCRATCH, "records"), "rb") as r:
        for seq in range(1, last + 1):
            rec = r.read(RECORD)
            got_seq, crc = struct.unpack("<QI", rec[:12])
            if got_seq != seq or zlib.crc32(rec[12:]) != crc:
                records_bad += 1
    return {
        "held": len(held),
        "held_bad": held_bad,
        "small_ok": read_all(small_fd, 64) == b"small deleted file\n",
        "large_ok": hashlib.sha256(read_all(large_fd, len(LARGE))).hexdigest() == large_sha,
        "linked_ok": read_all(linked_fd, 64) == b"linked",
        "linked_other_name_ok": open(os.path.join(SCRATCH, "linked.2"), "rb").read() == b"linked",
        "records": last,
        "records_bad": records_bad,
    }


threading.Thread(target=write_records, daemon=True).start()
open("/tmp/holder.ready", "w").close()
while True:
    try:
        nonce = open("/tmp/holder.req").read().strip()
        os.unlink("/tmp/holder.req")
    except FileNotFoundError:
        time.sleep(0.2)
        continue
    with open(f"/tmp/holder.{nonce}.tmp", "w") as f:
        json.dump(check(), f)
    os.rename(f"/tmp/holder.{nonce}.tmp", f"/tmp/holder.{nonce}.json")
