#!/usr/bin/env python3
"""fleet-launch.py — pty.fork fallback launcher (used when detached tmux fails)

usage: fleet-launch.py <project-dir> <cmd> [args...]
  Inside <project-dir>, after stripping all CLAUDE_CODE_* env vars, start <cmd> with a pty and detach
  (caller returns immediately, ccb keeps running in the background).

Why this way:
  - strip CLAUDE_CODE_*: parent session's OAuth/session env leaks to child cc-* → fake 401.
  - pty.fork: ccb needs a tty before it will start the agent pane.
  - fork + setsid: detach from the calling shell's session, ccb survives after the caller exits.
  - drain pty: prevent ccb from blocking when the output buffer fills up.
"""
import os
import pty
import sys


def main() -> int:
    if len(sys.argv) < 3:
        sys.stderr.write("usage: fleet-launch.py <project-dir> <cmd> [args...]\n")
        return 2
    project = sys.argv[1]
    cmd = sys.argv[2:]
    if not os.path.isdir(project):
        sys.stderr.write("fleet-launch: no directory %s\n" % project)
        return 2

    # 1) strip CLAUDE_CODE_* (keep provider key/PATH/HOME etc.)
    for k in [k for k in list(os.environ) if k.startswith("CLAUDE_CODE")]:
        del os.environ[k]

    # 2) status pipe: the daemon child reports whether the launch actually started,
    #    so the CALLER sees a nonzero exit on failure (e.g. out of ptys) even though
    #    the worker then runs detached. The parent waits only for the 1-byte status —
    #    never for the long-running worker itself.
    r, w = os.pipe()
    try:
        pid = os.fork()
    except OSError as e:
        os.close(r)
        os.close(w)
        sys.stderr.write("fleet-launch: fork failed (%s)\n" % e)
        return 127
    if pid > 0:
        os.close(w)
        status = b""
        try:
            status = os.read(r, 1)   # unblocks the moment the child signals (right after pty.fork)
        except OSError:
            pass
        os.close(r)
        return 0 if status == b"1" else 127

    # 3) child: detach from the tty session, then pty.fork the worker.
    #    Degrade gracefully (clean message, not a traceback) if the host is out of ptys.
    os.close(r)
    os.chdir(project)
    os.setsid()
    try:
        pid, fd = pty.fork()
    except OSError as e:
        try:
            os.write(w, b"0")
        except OSError:
            pass
        os.close(w)
        sys.stderr.write("fleet-launch: pty.fork failed (%s) — host may be out of pty devices\n" % e)
        os._exit(127)
    if pid == 0:
        # grandchild: exec the target command inside the pty (drop the status pipe).
        try:
            os.close(w)
        except OSError:
            pass
        try:
            os.execvp(cmd[0], cmd)
        except OSError as e:
            sys.stderr.write("exec %s failed: %s\n" % (cmd[0], e))
            os._exit(127)

    # 4) daemon: signal success to the caller, then drain pty output until the worker exits.
    try:
        os.write(w, b"1")
    except OSError:
        pass
    os.close(w)
    try:
        while True:
            try:
                if not os.read(fd, 4096):
                    break
            except OSError:
                break
    finally:
        os._exit(0)


if __name__ == "__main__":
    sys.exit(main())
