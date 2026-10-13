"""Execute the production helper with inert proc/pidfd syscall boundaries."""
import builtins
import io
import json
import os
import selectors
import signal
import sys
import time
from types import SimpleNamespace

source, members, model_json = sys.argv[1:]
model = json.loads(model_json)
scenario = model["scenario"]
table = {item["pid"]: item for item in model["processes"]}
directories = {fd: table[item["pid"]] for fd, item in model["inherited"]}
pidfds = {}
signals = []
replaced = False
clock = 0
engine = 100000002


def replace():
    global replaced
    table[engine]["alive"] = False
    table[engine] = {
        "pid": engine, "start": "99", "group": engine,
        "argv": ["openchamber", "unrelated-reused-pid"], "alive": True,
    }
    if scenario == "same-tick-reuse-before-open":
        table[engine]["start"] = "11"
        table[engine]["group"] = 100000001
    replaced = True


def pidfd_open(pid):
    if pid == engine and scenario == "pidfd-permission-denied":
        raise PermissionError("pidfd_open denied")
    if pid == engine and scenario in ("reuse-before-final-stat", "same-tick-reuse-before-open"):
        replace()
    fd = 9000 + len(pidfds)
    pidfds[fd] = table[pid]
    if pid == engine and scenario == "reuse-after-pidfd-open":
        replace()
    if pid == engine and scenario == "group-change":
        table[pid]["group"] = pid
    return fd


def proc_open(path):
    fd = int(path.split("/")[4])
    item = directories[fd]
    if not item["alive"]:
        raise FileNotFoundError(path)
    fields = ["0"] * 20
    fields[0], fields[2], fields[19] = "S", str(item["group"]), item["start"]
    stat = "%s (fixture) %s" % (item["pid"], " ".join(fields))
    # The same final-read/delivery interleaving as the Node reviewer: return
    # the original stat, then replace the PID before the caller can use it.
    if item["pid"] == engine and scenario == "reuse-between-final-stat-and-cmdline" and not replaced:
        replace()
    return io.StringIO(stat)


def send_signal(fd, sig):
    item = pidfds[fd]
    if item["pid"] == engine and scenario == "reuse-at-signal" and not replaced:
        replace()
    if not item["alive"]:
        raise ProcessLookupError()
    signals.append({
        "pid": item["pid"], "signal": signal.Signals(sig).name,
        "startAtSignal": item["start"],
        "nonOwned": item["pid"] != 100000001 and
                    (item["pid"] != engine or item["start"] != "11" or
                     "unrelated-reused-pid" in item["argv"]),
    })
    if item["pid"] == engine and sig == signal.SIGTERM and scenario in ("stubborn-engine", "reuse-before-escalation"):
        return
    item["alive"] = False


class Selector:
    def __init__(self):
        self.registered = set()

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def register(self, fd, events):
        self.registered.add(fd)

    def unregister(self, fd):
        self.registered.remove(fd)

    def select(self, timeout):
        global clock
        ready = [(SimpleNamespace(fd=fd), selectors.EVENT_READ)
                 for fd in self.registered if not pidfds[fd]["alive"]]
        if not ready:
            clock += timeout
            if scenario == "reuse-before-escalation" and not replaced:
                replace()
        return ready


os.pidfd_open = pidfd_open
os.close = lambda fd: pidfds.pop(fd)
signal.pidfd_send_signal = send_signal
if scenario == "pidfd-unavailable":
    del signal.pidfd_send_signal
selectors.DefaultSelector = Selector
time.monotonic = lambda: clock
builtins.open = proc_open
sys.argv = ["session-hosts", members]
try:
    exec(compile(source, "<session-hosts>", "exec"), {"__name__": "__main__"})
finally:
    assert not pidfds, "the helper must close every pidfd"
    print(json.dumps({
        "replaced": replaced, "signals": signals,
        "protectedAlive": all(table[pid]["alive"] for pid in (100000003, 100000004, 100000005)),
    }))
