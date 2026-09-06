import 'dart:js_interop';
import 'dart:ui' as ui;
import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';

@JS('owlsFlutterEvent')
external void _emit(JSString phase, JSNumber count, JSNumber viewId);
void report(String phase, int count, int viewId) => _emit(phase.toJS, count.toJS, viewId.toJS);

// Retained for the life of this test application so real controls remain accessible
// to keyboard and browser automation. No fabricated DOM button stands in for Flutter.
SemanticsHandle? semantics;
void main() {
  WidgetsFlutterBinding.ensureInitialized();
  semantics = SemanticsBinding.instance.ensureSemantics();
  report('main', 0, -1);
  runWidget(const PilotViews());
}

class PilotViews extends StatefulWidget {
  const PilotViews({super.key});
  @override
  State<PilotViews> createState() => _PilotViewsState();
}

class _PilotViewsState extends State<PilotViews> with WidgetsBindingObserver {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }
  @override
  void didChangeMetrics() => setState(() {});
  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }
  @override
  Widget build(BuildContext context) => ViewCollection(views: <Widget>[
    for (final ui.FlutterView view in WidgetsBinding.instance.platformDispatcher.views)
      View(key: ValueKey<int>(view.viewId), view: view, child: PilotApp(viewId: view.viewId)),
  ]);
}

class PilotApp extends StatefulWidget {
  const PilotApp({required this.viewId, super.key});
  final int viewId;
  @override
  State<PilotApp> createState() => _PilotAppState();
}

class _PilotAppState extends State<PilotApp> {
  int count = 0;
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) report('ready', count, widget.viewId);
    });
  }
  void increment() {
    setState(() { count += 1; });
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) report('changed', count, widget.viewId);
    });
  }
  @override
  void dispose() {
    report('disposed', count, widget.viewId);
    super.dispose();
  }
  @override
  Widget build(BuildContext context) => MaterialApp(
    debugShowCheckedModeBanner: false,
    home: Scaffold(body: Center(child: Column(mainAxisSize: MainAxisSize.min, children: <Widget>[
      const Text('Flutter multi-view pilot'),
      ElevatedButton(onPressed: increment, child: const Text('Increment Flutter')),
      Text('Flutter count: $count'),
    ]))),
  );
}
