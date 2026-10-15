"""Synthetic evidence fixtures only; no benchmark data belongs here."""
import json
import tempfile
import unittest
from pathlib import Path
import score_scanner as scorer


class EvidenceTests(unittest.TestCase):
    def metrics(self, lines, **extra):
        entries = [{"key": "synthetic", "file": "sample.py", "line": 10,
                    "codes": {"A01"}, **extra}]
        findings = [{"finding_id": str(i), "categories": [code],
                     "trace": [{"file": "sample.py", "line": line}]}
                    for i, (line, code) in enumerate(lines)]
        return scorer.score(findings, entries, {"access": ["A01"]}, {"A01": "access"}, False)

    def test_legacy_point_and_slack(self):
        self.assertEqual(self.metrics([(10, "A01")])["recall"]["hits"], 1)
        self.assertEqual(self.metrics([(25, "A01")])["localization"]["hits"], 1)
        self.assertEqual(self.metrics([(26, "A01")])["localization"]["hits"], 0)
        self.assertEqual(self.metrics([(None, "A01")])["file_level"]["hits"], 1)

    def test_alternates_count_entry_once(self):
        m = self.metrics([(40, "A01"), (60, "A01")], alt_lines=[40, 60])
        self.assertEqual(m["recall"], {"hits": 1, "total": 1, "pct": 100.0})
        self.assertEqual(m["precision_proxy"]["category_matched_findings"], 2)

    def test_range_inclusive_and_nearest_distance(self):
        for line in [10, 15, 20]:
            self.assertEqual(self.metrics([(line, "A01")], line_end=20)["recall"]["hits"], 1)
        for line in [9, 21]:
            self.assertEqual(self.metrics([(line, "A01")], line_end=20)["recall"]["hits"], 0)
        self.assertEqual(self.metrics([(35, "A01")], line_end=20)["localization"]["hits"], 1)
        self.assertEqual(self.metrics([(36, "A01")], line_end=20)["localization"]["hits"], 0)
        self.assertEqual(self.metrics([(70, "A01")], line_end=20, alt_lines=[70])["recall"]["hits"], 1)

    def test_categories_still_required(self):
        m = self.metrics([(50, "A02")], alt_lines=[50])
        self.assertEqual(m["recall"]["hits"], 0)
        self.assertEqual(m["recall_category_blind"]["hits"], 1)
        self.assertEqual(m["precision_proxy"]["category_aware"], 0)

    def test_load_preserves_optional_fields(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp)/"key.json"
            p.write_text(json.dumps({"benchmark_ground_truth": [
                {"challengeKey": "synthetic", "file": "sample.py", "line": 10,
                 "alt_lines": [80], "line_end": 20, "owasp_codes": ["A01"]}]}))
            self.assertEqual(scorer.evidence_distance(80, scorer.load_ground_truth(p)[0]), 0)

    def test_malformed_ranges_rejected(self):
        for extra in [{"line_end": 9}, {"alt_lines": [0]}, {"alt_lines": "12"}]:
            with self.assertRaises(ValueError):
                self.metrics([(10, "A01")], **extra)


if __name__ == "__main__":
    unittest.main()
