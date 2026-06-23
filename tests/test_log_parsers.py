#!/usr/bin/env python3
"""
Regression tests for the log aggregator parsers.

Tests use hand-written sample log lines to validate parser behavior
independently — no parser-generated fixtures. Covers valid and malformed
JSON logs, plain text application logs, syslog-style lines, Nginx access
logs, empty lines, HTTP 4xx/5xx classification, timestamp extraction edge
cases, and unknown severity handling.

IMPORTANT: These tests do NOT read from production logs, generated parser
output, or network resources. All test data is defined inline.

Limitations (not covered by these tests):
- The TextLogParser.extract_service() method has heuristics that may
  misidentify service names when the log line contains colons outside
  the service prefix. This is a known fragility of the regex approach.
- No performance/stress tests for large log volumes.
"""

import json
import os
import sys
import unittest

# Ensure tools directory is on the path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from tools.log_aggregator import (
    JSONLogParser,
    TextLogParser,
    NginxLogParser,
    LogParser,
)


class TestJSONLogParser(unittest.TestCase):
    """Regression tests for JSONLogParser."""

    def setUp(self):
        self.parser = JSONLogParser()

    def test_valid_json_log(self):
        """Parse a standard JSON log entry."""
        line = '{"timestamp": "2024-01-15T10:30:00", "level": "ERROR", "service": "api-gateway", "message": "Connection timeout"}'
        result = self.parser.parse(line)
        self.assertIsNotNone(result)
        self.assertEqual(result["format"], "json")
        self.assertEqual(result["level"], "ERROR")
        self.assertEqual(result["service"], "api-gateway")
        self.assertEqual(result["message"], "Connection timeout")

    def test_json_with_time_field(self):
        """Parse JSON log using 'time' key as timestamp fallback."""
        line = '{"time": "2024-01-15T10:30:00", "severity": "WARN", "logger": "auth-service", "msg": "Rate limit approaching"}'
        result = self.parser.parse(line)
        self.assertIsNotNone(result)
        self.assertEqual(result["timestamp"], "2024-01-15T10:30:00")
        self.assertEqual(result["level"], "WARN")
        self.assertEqual(result["service"], "auth-service")
        self.assertEqual(result["message"], "Rate limit approaching")

    def test_json_with_at_timestamp(self):
        """Parse JSON log using '@timestamp' field."""
        line = '{"@timestamp": "2024-01-15T10:30:00", "lvl": "info", "app": "web", "event": "Request started"}'
        result = self.parser.parse(line)
        self.assertIsNotNone(result)
        self.assertEqual(result["timestamp"], "2024-01-15T10:30:00")
        self.assertEqual(result["level"], "info")
        self.assertEqual(result["service"], "web")
        self.assertEqual(result["message"], "Request started")

    def test_malformed_json(self):
        """Return None for unparseable JSON."""
        line = '{"timestamp": "2024-01-15", "level": "INFO", broken json here'
        result = self.parser.parse(line)
        self.assertIsNone(result)

    def test_invalid_json_type(self):
        """Return None when JSON parses but is not a dict."""
        line = '["not", "a", "dict"]'
        result = self.parser.parse(line)
        self.assertIsNone(result)

    def test_empty_json_object(self):
        """Parse an empty JSON object with all fallback defaults."""
        line = "{}"
        result = self.parser.parse(line)
        self.assertIsNotNone(result)
        self.assertEqual(result["message"], "")
        self.assertEqual(result["format"], "json")

    def test_json_missing_all_fields(self):
        """Parse JSON with unknown keys — all field getters should return None."""
        line = '{"unknown_key": "some_value", "other": 42}'
        result = self.parser.parse(line)
        self.assertIsNotNone(result)
        # timestamp, level, service, message all fall back to defaults
        self.assertEqual(result["message"], "")
        self.assertEqual(result["format"], "json")

    def test_json_level_fallbacks(self):
        """Test all level key variants are picked up."""
        cases = [
            ('{"level": "ERROR"}', "ERROR"),
            ('{"severity": "CRITICAL"}', "CRITICAL"),
            ('{"lvl": "debug"}', "debug"),
        ]
        for line, expected_level in cases:
            result = self.parser.parse(line)
            self.assertIsNotNone(result)
            self.assertEqual(result["level"], expected_level)

    def test_json_service_fallbacks(self):
        """Test all service key variants are picked up."""
        cases = [
            ('{"service": "billing"}', "billing"),
            ('{"logger": "db-pool"}', "db-pool"),
            ('{"app": "frontend"}', "frontend"),
        ]
        for line, expected_service in cases:
            result = self.parser.parse(line)
            self.assertIsNotNone(result)
            self.assertEqual(result["service"], expected_service)


class TestTextLogParser(unittest.TestCase):
    """Regression tests for TextLogParser."""

    def setUp(self):
        self.parser = TextLogParser()

    def test_empty_line(self):
        """Return None for blank or whitespace-only lines."""
        self.assertIsNone(self.parser.parse(""))
        self.assertIsNone(self.parser.parse("   "))
        self.assertIsNone(self.parser.parse("\t"))
        self.assertIsNone(self.parser.parse("\n"))

    def test_standard_log_line(self):
        """Parse a standard timestamped log line.

        NOTE: The bracket-based service extraction uses ``r'\\[(\\w+)\\]'``
        where ``\\w`` matches ``[a-zA-Z0-9_]`` only — hyphens are not
        included. So a service name like ``[api-gateway]`` will not match
        because the hyphen is not a word character. The colon-based
        fallback also fails because the timestamp colons match first
        (``10:`` before any service label). This is a known limitation
        of the legacy regex-based parser.

        Service names without hyphens work correctly:
        """
        line = "2024-01-15 10:30:00 [API] ERROR Connection timeout after 30s"
        result = self.parser.parse(line)
        self.assertIsNotNone(result)
        self.assertEqual(result["format"], "text")
        self.assertEqual(result["level"], "error")
        self.assertEqual(result["service"], "API")
        self.assertIn("Connection timeout", result["message"])

    def test_iso8601_timestamp_extraction(self):
        """Extract ISO-8601 timestamp correctly."""
        line = "2024-01-15T10:30:00 [worker] INFO Job completed"
        result = self.parser.parse(line)
        self.assertIsNotNone(result)
        self.assertIsNotNone(result["timestamp"])
        self.assertIsInstance(result["timestamp"], int)

    def test_syslog_style_timestamp(self):
        """Extract syslog-style timestamp (e.g., 'Jan 15 10:30:00')."""
        line = "Jan 15 10:30:00 myhost sshd[1234]: Failed password for root"
        result = self.parser.parse(line)
        self.assertIsNotNone(result)
        # Syslog timestamps without year may be parsed
        self.assertIsNotNone(result["timestamp"])

    def test_extract_level_case_insensitive(self):
        """Level extraction is case-insensitive."""
        line = "2024-01-15 10:30:00 [test] warn This is a warning"
        result = self.parser.parse(line)
        self.assertIsNotNone(result)
        self.assertEqual(result["level"], "warn")

    def test_unknown_severity(self):
        """Lines without a known severity level default to 'unknown'."""
        line = "2024-01-15 10:30:00 [test] This is a message without severity"
        result = self.parser.parse(line)
        self.assertIsNotNone(result)
        self.assertEqual(result["level"], "unknown")

    def test_fatal_and_critical_severity(self):
        """FATAL and CRITICAL levels are classified as 'error'."""
        fatal_line = "2024-01-15 10:30:00 [core] FATAL Out of memory"
        result_f = self.parser.parse(fatal_line)
        self.assertIsNotNone(result_f)
        self.assertEqual(result_f["level"], "error")

        critical_line = "2024-01-15 10:30:00 [core] CRITICAL Disk failure imminent"
        result_c = self.parser.parse(critical_line)
        self.assertIsNotNone(result_c)
        self.assertEqual(result_c["level"], "error")

    def test_service_extraction_bracket(self):
        """Extract service name from [ServiceName] pattern."""
        line = "2024-01-15 10:30:00 [database] INFO Query executed"
        result = self.parser.parse(line)
        self.assertIsNotNone(result)
        self.assertEqual(result["service"], "database")

    def test_service_extraction_colon(self):
        """Extract service name from SERVICE: pattern.

        NOTE: The regex ``r'(\\w+)\\s*:'`` uses ``re.search`` which returns
        the *first* match. When the line contains a timestamp with colons
        (e.g. ``10:30:00``), the first match is ``10:`` (group 1 = ``10``),
        which fails the ``isupper()`` guard. This is a known limitation of
        the legacy parser — timestamp-like patterns that include colons
        before the service label will shadow the extraction.

        When the line has no timestamp colons before the service label,
        the extraction works:
        """
        line = "AUTH: Login attempt from 10.0.0.1"
        result = self.parser.parse(line)
        self.assertIsNotNone(result)
        self.assertEqual(result["service"], "AUTH")

    def test_service_extraction_none(self):
        """Return None service when no pattern matches."""
        line = "2024-01-15 10:30:00 some random log message without service"
        result = self.parser.parse(line)
        self.assertIsNotNone(result)
        self.assertIsNone(result["service"])

    def test_debug_level(self):
        """DEBUG and TRACE levels are parsed correctly."""
        debug_line = "2024-01-15 10:30:00 [app] DEBUG Variable x = 42"
        result = self.parser.parse(debug_line)
        self.assertIsNotNone(result)
        self.assertEqual(result["level"], "debug")

        trace_line = "2024-01-15 10:30:00 [app] TRACE Entering function foo"
        result_t = self.parser.parse(trace_line)
        self.assertIsNotNone(result_t)
        self.assertEqual(result_t["level"], "debug")

    def test_no_timestamp(self):
        """Line without a recognizable timestamp still parses, timestamp is None."""
        line = "just some random text without a timestamp"
        result = self.parser.parse(line)
        self.assertIsNotNone(result)
        self.assertIsNone(result["timestamp"], "Timestamp should be None when no pattern matches")


class TestNginxLogParser(unittest.TestCase):
    """Regression tests for NginxLogParser."""

    def setUp(self):
        self.parser = NginxLogParser()

    def test_valid_nginx_line(self):
        """Parse a standard Nginx combined log format line."""
        line = '192.168.1.1 - - [15/Jan/2024:10:30:00 +0000] "GET /api/health HTTP/1.1" 200 1234 "-" "curl/7.68.0"'
        result = self.parser.parse(line)
        self.assertIsNotNone(result)
        self.assertEqual(result["format"], "nginx")
        self.assertEqual(result["service"], "nginx")
        self.assertEqual(result["level"], "info")
        self.assertEqual(result["fields"]["status"], 200)
        self.assertEqual(result["fields"]["remote_addr"], "192.168.1.1")

    def test_nginx_4xx_classification(self):
        """4xx status codes are classified as 'warn'."""
        line = '10.0.0.1 - - [15/Jan/2024:10:30:00 +0000] "POST /api/login HTTP/1.1" 401 89 "-" "Mozilla/5.0"'
        result = self.parser.parse(line)
        self.assertIsNotNone(result)
        self.assertEqual(result["level"], "warn")
        self.assertEqual(result["fields"]["status"], 401)

    def test_nginx_5xx_classification(self):
        """5xx status codes are classified as 'error'."""
        line = '10.0.0.1 - - [15/Jan/2024:10:30:00 +0000] "GET /api/db HTTP/1.1" 503 0 "-" "curl/7.68.0"'
        result = self.parser.parse(line)
        self.assertIsNotNone(result)
        self.assertEqual(result["level"], "error")
        self.assertEqual(result["fields"]["status"], 503)

    def test_nginx_404_classification(self):
        """404 (client error) is classified as 'warn'."""
        line = '10.0.0.1 - - [15/Jan/2024:10:30:00 +0000] "GET /missing HTTP/1.1" 404 27 "-" "curl/7.68.0"'
        result = self.parser.parse(line)
        self.assertIsNotNone(result)
        self.assertEqual(result["level"], "warn")
        self.assertEqual(result["fields"]["status"], 404)

    def test_nginx_3xx_classification(self):
        """3xx redirect status codes are classified as 'info'."""
        line = '10.0.0.1 - - [15/Jan/2024:10:30:00 +0000] "GET /old-path HTTP/1.1" 301 178 "-" "curl/7.68.0"'
        result = self.parser.parse(line)
        self.assertIsNotNone(result)
        self.assertEqual(result["level"], "info")
        self.assertEqual(result["fields"]["status"], 301)

    def test_malformed_nginx_line(self):
        """Return None for unparseable Nginx log lines."""
        line = "this is not an nginx log line at all"
        result = self.parser.parse(line)
        self.assertIsNone(result)

    def test_nginx_with_referer_and_ua(self):
        """Parse Nginx line with referer and user-agent.

        NOTE: The parser maps field group(2) (the ident field in standard
        combined format, typically ``-``) to ``remote_user``. In the test
        line, ``192.168.1.1 - admin [...]``, group(1)=192.168.1.1,
        group(2)=``-`` (ident), group(3)=admin (actual remote user).
        The parser stores group(2) as ``remote_user``, so the expected
        value is ``-``. This is a known quirk of the legacy parser.
        """
        line = '192.168.1.1 - admin [15/Jan/2024:14:22:10 +0000] "PUT /api/users HTTP/1.1" 200 512 "https://example.com" "Mozilla/5.0 (X11; Linux x86_64)"'
        result = self.parser.parse(line)
        self.assertIsNotNone(result)
        self.assertEqual(result["fields"]["referer"], "https://example.com")
        # group(2) = ident field (typically "-"), mapped as "remote_user"
        self.assertEqual(result["fields"]["remote_user"], "-")
        self.assertIn("Mozilla", result["fields"]["user_agent"])


class TestBaseLogParser(unittest.TestCase):
    """Tests for the base LogParser utility methods."""

    def setUp(self):
        self.parser = LogParser()

    def test_empty_line_no_crash(self):
        """Base parser should not crash on malformed input."""
        result = self.parser.extract_timestamp("")
        self.assertIsNone(result)
        level = self.parser.extract_level("")
        self.assertEqual(level, "unknown")

    def test_extract_timestamp_iso8601(self):
        """ISO-8601 timestamp extraction."""
        ts = self.parser.extract_timestamp("2024-06-15T10:30:00 some message")
        self.assertIsNotNone(ts)
        self.assertIsInstance(ts, int)

    def test_extract_timestamp_standard(self):
        """Standard timestamp format extraction."""
        ts = self.parser.extract_timestamp("2024-06-15 10:30:00 some message")
        self.assertIsNotNone(ts)
        self.assertIsInstance(ts, int)

    def test_extract_timestamp_nginx(self):
        """Nginx-style timestamp extraction.

        NOTE: The TIMESTAMP_PATTERNS regex includes an optional leading '['
        (via ``\\[?``) but the ``strptime`` format ``%d/%b/%Y:%H:%M:%S`` does
        NOT include the bracket. Therefore a line like
        ``[15/Jun/2024:10:30:00 +0000]`` will fail parsing because ``strptime``
        cannot handle the leading ``[``. This is a known limitation of the
        legacy parser and is documented here rather than silently passing.

        If the timestamp appears without surrounding brackets it works::
        """
        # Without the leading bracket this succeeds:
        ts = self.parser.extract_timestamp("15/Jun/2024:10:30:00 some message")
        self.assertIsNotNone(ts)
        self.assertIsInstance(ts, int)

    def test_extract_timestamp_syslog(self):
        """Syslog-style timestamp extraction (no year)."""
        ts = self.parser.extract_timestamp("Jun 15 10:30:00 myhost message")
        self.assertIsNotNone(ts)
        self.assertIsInstance(ts, int)

    def test_extract_timestamp_no_match(self):
        """Return None when no timestamp pattern matches."""
        ts = self.parser.extract_timestamp("no timestamp here")
        self.assertIsNone(ts)

    def test_extract_level_error_patterns(self):
        """Extract error level from various patterns."""
        self.assertEqual(self.parser.extract_level("ERROR: something broke"), "error")
        self.assertEqual(self.parser.extract_level("FATAL: system crash"), "error")
        self.assertEqual(self.parser.extract_level("CRITICAL: disk full"), "error")

    def test_extract_level_warn_patterns(self):
        """Extract warn level from various patterns."""
        self.assertEqual(self.parser.extract_level("WARN: approaching limit"), "warn")
        self.assertEqual(self.parser.extract_level("WARNING: high memory"), "warn")

    def test_extract_level_info_patterns(self):
        """Extract info level from various patterns."""
        self.assertEqual(self.parser.extract_level("INFO: server started"), "info")
        self.assertEqual(self.parser.extract_level("NOTICE: configuration reloaded"), "info")

    def test_extract_level_debug_patterns(self):
        """Extract debug level from various patterns."""
        self.assertEqual(self.parser.extract_level("DEBUG: variable x=1"), "debug")
        self.assertEqual(self.parser.extract_level("TRACE: entered function"), "debug")


if __name__ == "__main__":
    unittest.main()
