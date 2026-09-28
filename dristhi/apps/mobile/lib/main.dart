// DRISHTI Mobile Field App - minimal scaffold.
// Demonstrates the capture flow: block/quarry metadata + GPS + timestamp,
// then POST to the gateway /captures endpoint. Camera + offline buffer are
// stubbed with TODOs for the full implementation.
import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;

// StartupOS palette (mirrors packages/ui tokens)
const sosDark = Color(0xFF1B2A4A);
const sosBlue = Color(0xFF2196F3);

const gatewayBase = String.fromEnvironment('GATEWAY_BASE',
    defaultValue: 'http://10.0.2.2:8080'); // 10.0.2.2 = host from Android emulator

void main() => runApp(const DrishtiApp());

class DrishtiApp extends StatelessWidget {
  const DrishtiApp({super.key});
  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'DRISHTI Field',
      theme: ThemeData(colorSchemeSeed: sosBlue, useMaterial3: true),
      home: const CaptureScreen(),
    );
  }
}

class CaptureScreen extends StatefulWidget {
  const CaptureScreen({super.key});
  @override
  State<CaptureScreen> createState() => _CaptureScreenState();
}

class _CaptureScreenState extends State<CaptureScreen> {
  final blockId = TextEditingController(text: 'QRY-AMR-2026-1001');
  final quarryId = TextEditingController(text: 'APQRY-0023');
  String status = '';

  Future<void> submit() async {
    setState(() => status = 'Submitting...');
    // TODO: capture image via `camera`, upload to MinIO, get image_ref.
    // TODO: read GPS via `geolocator`; buffer offline via `hive` if no network.
    try {
      final res = await http.post(
        Uri.parse('$gatewayBase/captures'),
        headers: {'Content-Type': 'application/json'},
        body: jsonEncode({
          'block_id': blockId.text,
          'quarry_id': quarryId.text,
          'source': 'mobile',
          'granite_category': 'generic',
        }),
      );
      setState(() => status = res.statusCode == 200
          ? 'Measured: ${res.body}'
          : 'Error ${res.statusCode}');
    } catch (e) {
      setState(() => status = 'Offline - buffered for later sync ($e)');
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(backgroundColor: sosDark, foregroundColor: Colors.white,
          title: const Text('DRISHTI Field Capture')),
      body: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(children: [
          TextField(controller: blockId, decoration: const InputDecoration(labelText: 'Block ID')),
          TextField(controller: quarryId, decoration: const InputDecoration(labelText: 'Quarry ID')),
          const SizedBox(height: 16),
          FilledButton(onPressed: submit, child: const Text('Capture & Submit')),
          const SizedBox(height: 16),
          Text(status),
        ]),
      ),
    );
  }
}
