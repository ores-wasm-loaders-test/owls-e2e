import 'dart:ui' as ui;
import 'package:flutter/widgets.dart';

void main() => runWidget(const ProductViews());
class ProductViews extends StatefulWidget {
  const ProductViews({super.key});
  @override
  State<ProductViews> createState() => _ProductViewsState();
}
class _ProductViewsState extends State<ProductViews> with WidgetsBindingObserver {
  @override
  void initState() { super.initState(); WidgetsBinding.instance.addObserver(this); }
  @override
  void didChangeMetrics() { setState(() {}); }
  @override
  void dispose() { WidgetsBinding.instance.removeObserver(this); super.dispose(); }
  @override
  Widget build(BuildContext context) => ViewCollection(views: [
    for (final ui.FlutterView view in WidgetsBinding.instance.platformDispatcher.views)
      View(view:view, child:Directionality(textDirection:TextDirection.ltr,
        child:ColoredBox(color:const Color(0xFFEAF4FF),child:Center(
          child:Text('OWLS Flutter view ${view.viewId}',style:const TextStyle(fontSize:24,color:Color(0xFF123456)))))))
  ]);
}

