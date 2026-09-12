import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';
import 'package:flutter_test/flutter_test.dart';
import 'package:owls_flutter/owls_flutter.dart';
class TenantTransport implements AssetTransport {
  @override
  Future<Uint8List> fetch(WasmAsset asset,Cancellation cancellation) async => Uint8List.fromList([0,97,115,109,1,0,0,0]);
}
void main(){
  test('published contract corpus',(){
    final cases=jsonDecode(File('../fixtures/contracts/cases.json').readAsStringSync()) as List;
    for(final item in cases){
      var accepted=false;
      try{parseRelease(item['manifest'],['https://assets.example']);accepted=true;}catch(_){}
      expect(accepted,item['valid'],reason:item['name']);
    }
  });
  test('external product transport composes with published host',() async{
    final cases=jsonDecode(File('../fixtures/contracts/cases.json').readAsStringSync()) as List;
    final host=WasmHost(cases.first['manifest'],policy:LoaderPolicy(origins:['https://assets.example']),transport:TenantTransport());
    await host.prefetch();
    expect((await host.bytes('main',Cancellation())).length,8);
  });
}

