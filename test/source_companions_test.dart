import 'package:flutter_test/flutter_test.dart';
import 'package:THLRedLook/core/js/source_companions.dart';

/// 站源互备关系：只做一跳回退，不做递归。
void main() {
  group('companionSourceOf', () {
    test('官方源失败时回退到网页源，反之亦然', () {
      expect(companionSourceOf('hongguo'), 'hongguo-web');
      expect(companionSourceOf('hongguo-web'), 'hongguo');
    });

    test('网关源只降级到网页源', () {
      expect(companionSourceOf('hongguo-gw'), 'hongguo-web');
    });

    test('未配置的源返回 null', () {
      expect(companionSourceOf('unknown-source'), isNull);
      expect(companionSourceOf(''), isNull);
    });

    test('自映射视为无备份，避免同源重试', () {
      expect(companionSourceOf('hongguo-gw'), isNot('hongguo-gw'));
    });
  });
}
