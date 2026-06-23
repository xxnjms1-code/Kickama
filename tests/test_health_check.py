#!/usr/bin/env python3
"""
Unit tests for the health check core utility.

Tests cover checking HTTP services, TCP ports, disk usage, and memory usage.
It uses unittest.mock to simulate various system and network states.
"""

import os
import socket
import sys
import unittest
from unittest.mock import MagicMock, patch

# Ensure tools directory is on the path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from tools.health_check import (
    check_http_service,
    check_tcp_port,
    check_disk_usage,
    check_memory_usage,
    check_load_average,
    DISK_THRESHOLD_WARNING,
    DISK_THRESHOLD_CRITICAL,
    MEMORY_THRESHOLD_WARNING,
    MEMORY_THRESHOLD_CRITICAL,
)


class TestHealthCheck(unittest.TestCase):
    """Tests for individual health check functions."""

    @patch("http.client.HTTPConnection")
    def test_check_http_service_ok(self, mock_conn_class):
        """Test HTTP service check returns OK on 200 status."""
        mock_conn = MagicMock()
        mock_resp = MagicMock()
        mock_resp.status = 200
        mock_resp.read.return_value = b"OK"
        mock_conn.getresponse.return_value = mock_resp
        mock_conn_class.return_value = mock_conn

        status, detail, code = check_http_service("localhost", 8080, "/health", 5)
        
        self.assertEqual(status, "OK")
        self.assertEqual(code, 200)
        self.assertIn("HTTP 200", detail)

    @patch("http.client.HTTPConnection")
    def test_check_http_service_warning(self, mock_conn_class):
        """Test HTTP service check returns WARNING on 4xx status."""
        mock_conn = MagicMock()
        mock_resp = MagicMock()
        mock_resp.status = 404
        mock_resp.read.return_value = b"Not Found"
        mock_conn.getresponse.return_value = mock_resp
        mock_conn_class.return_value = mock_conn

        status, detail, code = check_http_service("localhost", 8080, "/health", 5)
        
        self.assertEqual(status, "WARNING")
        self.assertEqual(code, 404)
        self.assertIn("HTTP 404", detail)

    @patch("http.client.HTTPConnection")
    def test_check_http_service_critical(self, mock_conn_class):
        """Test HTTP service check returns CRITICAL on 5xx status."""
        mock_conn = MagicMock()
        mock_resp = MagicMock()
        mock_resp.status = 503
        mock_resp.read.return_value = b"Service Unavailable"
        mock_conn.getresponse.return_value = mock_resp
        mock_conn_class.return_value = mock_conn

        status, detail, code = check_http_service("localhost", 8080, "/health", 5)
        
        self.assertEqual(status, "CRITICAL")
        self.assertEqual(code, 503)

    @patch("http.client.HTTPConnection")
    def test_check_http_service_exception(self, mock_conn_class):
        """Test HTTP service check handles connection exceptions."""
        mock_conn_class.side_effect = Exception("Connection refused")

        status, detail, code = check_http_service("localhost", 8080, "/health", 5)
        
        self.assertEqual(status, "CRITICAL")
        self.assertEqual(code, 0)
        self.assertIn("Connection refused", detail)

    @patch("socket.create_connection")
    @patch("time.time")
    def test_check_tcp_port_ok(self, mock_time, mock_create_conn):
        """Test TCP port check returns OK when connection succeeds."""
        mock_time.side_effect = [100.0, 100.05] # 50ms latency
        mock_sock = MagicMock()
        mock_create_conn.return_value = mock_sock

        status, detail, latency = check_tcp_port("localhost", 5432, 5)
        
        self.assertEqual(status, "OK")
        self.assertAlmostEqual(latency, 50.0)
        mock_sock.close.assert_called_once()

    @patch("socket.create_connection")
    def test_check_tcp_port_timeout(self, mock_create_conn):
        """Test TCP port check handles timeouts."""
        mock_create_conn.side_effect = socket.timeout()

        status, detail, latency = check_tcp_port("localhost", 5432, 5)
        
        self.assertEqual(status, "CRITICAL")
        self.assertEqual(latency, 0)
        self.assertIn("Connection timeout", detail)

    @patch("os.statvfs")
    def test_check_disk_usage_ok(self, mock_statvfs):
        """Test disk usage below warning threshold."""
        mock_stat = MagicMock()
        mock_stat.f_frsize = 4096
        mock_stat.f_blocks = 1000000  # Total
        mock_stat.f_bavail = 500000   # 50% free
        mock_statvfs.return_value = mock_stat

        status, detail, pct = check_disk_usage("/")
        
        self.assertEqual(status, "OK")
        self.assertEqual(pct, 50.0)

    @patch("os.statvfs")
    def test_check_disk_usage_warning(self, mock_statvfs):
        """Test disk usage above warning threshold but below critical."""
        mock_stat = MagicMock()
        mock_stat.f_frsize = 4096
        mock_stat.f_blocks = 1000000  # Total
        mock_stat.f_bavail = 150000   # 15% free (85% used)
        mock_statvfs.return_value = mock_stat

        status, detail, pct = check_disk_usage("/")
        
        self.assertEqual(status, "WARNING")
        self.assertEqual(pct, 85.0)

    @patch("os.statvfs")
    def test_check_disk_usage_critical(self, mock_statvfs):
        """Test disk usage above critical threshold."""
        mock_stat = MagicMock()
        mock_stat.f_frsize = 4096
        mock_stat.f_blocks = 1000000  # Total
        mock_stat.f_bavail = 50000    # 5% free (95% used)
        mock_statvfs.return_value = mock_stat

        status, detail, pct = check_disk_usage("/")
        
        self.assertEqual(status, "CRITICAL")
        self.assertEqual(pct, 95.0)

    @patch("builtins.open")
    def test_check_memory_usage_ok(self, mock_open):
        """Test memory usage below warning threshold."""
        mock_file = MagicMock()
        mock_file.__enter__.return_value = [
            "MemTotal:       16000000 kB\n",
            "MemAvailable:    8000000 kB\n"
        ]
        mock_open.return_value = mock_file

        status, detail, pct = check_memory_usage()
        
        self.assertEqual(status, "OK")
        self.assertEqual(pct, 50.0)

    @patch("builtins.open")
    def test_check_memory_usage_critical(self, mock_open):
        """Test memory usage above critical threshold."""
        mock_file = MagicMock()
        mock_file.__enter__.return_value = [
            "MemTotal:       16000000 kB\n",
            "MemAvailable:     800000 kB\n" # 5% available, 95% used
        ]
        mock_open.return_value = mock_file

        status, detail, pct = check_memory_usage()
        
        self.assertEqual(status, "CRITICAL")
        self.assertEqual(pct, 95.0)

    @patch("builtins.open")
    @patch("os.cpu_count")
    def test_check_load_average_ok(self, mock_cpu_count, mock_open):
        """Test load average below warning threshold."""
        mock_cpu_count.return_value = 4
        mock_file = MagicMock()
        mock_file.read.return_value = "1.50 1.20 1.05 1/400 12345"
        mock_open.return_value.__enter__.return_value = mock_file

        status, detail, load = check_load_average()
        
        self.assertEqual(status, "OK")
        self.assertEqual(load, 1.5)
        # 1.5 load on 4 cores = 37.5%
        self.assertIn("38% of 4 cores", detail)


if __name__ == "__main__":
    unittest.main()
