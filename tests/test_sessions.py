"""驗證成績存檔：append/load round-trip。"""
from src.server import sessions


def test_append_and_load(tmp_path):
    f = tmp_path / "sessions.jsonl"

    assert sessions.load_sessions(f) == []          # 檔案不存在 → 空清單

    sessions.append_session({"replay_date": "2026-06-12", "total": 1200}, path=f)
    sessions.append_session({"replay_date": "2026-06-11", "total": -800}, path=f)

    recs = sessions.load_sessions(f)
    assert len(recs) == 2
    assert recs[0]["replay_date"] == "2026-06-12"
    assert recs[1]["total"] == -800


def test_clear(tmp_path):
    f = tmp_path / "sessions.jsonl"
    sessions.append_session({"total": 100}, path=f)
    assert len(sessions.load_sessions(f)) == 1

    sessions.clear_sessions(f)
    assert sessions.load_sessions(f) == []
    sessions.clear_sessions(f)            # 再清一次不報錯（檔案不存在）
