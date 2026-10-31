import 'package:flutter_test/flutter_test.dart';
import 'package:THLRedLook/core/catalog/source_dedupe.dart';
import 'package:THLRedLook/models/catalog/models.dart';

/// 跨源去重的规则回归。
///
/// 这些用例对应真实踩过的坑：
///  - 同一部剧被官方源与网页源各返回一次 → 必须合并成一条；
///  - 不同源的 series_id 撞号但剧名不同 → 绝不能合并；
///  - 「归路」与「归路 第二季」曾因包含匹配被误并 → 现在只认归一化全等。
Drama drama({
  required String source,
  required String seriesId,
  required String title,
  int episodes = 0,
  String cover = '',
  String description = '',
}) {
  return Drama(
    id: '$source:$seriesId',
    source: source,
    sourceId: seriesId,
    title: title,
    episodes: episodes,
    cover: cover,
    description: description,
  );
}

void main() {
  group('SourceDedupe.apply', () {
    test('同一部剧来自两个源时合并为一条，保留优先级更高的源', () {
      final merged = SourceDedupe.apply([
        drama(
          source: 'hongguo',
          seriesId: '7699683909419666457',
          title: '归路',
          episodes: 78,
          cover: 'cover-a',
        ),
        drama(
          source: 'hongguo-web',
          seriesId: '7699683909419666457',
          title: '归路',
          episodes: 78,
        ),
      ]);

      expect(merged, hasLength(1));
      expect(merged.single.source, 'hongguo');
      expect(merged.single.cover, 'cover-a');
      expect(merged.single.cleanSourceId, '7699683909419666457');
    });

    test('缺失字段由另一条补齐，集数取较大值', () {
      final merged = SourceDedupe.apply([
        drama(
          source: 'hongguo',
          seriesId: '1234567',
          title: '测试剧',
          episodes: 20,
        ),
        drama(
          source: 'hongguo-web',
          seriesId: '1234567',
          title: '测试剧',
          episodes: 24,
          description: '简介来自网页版',
        ),
      ]);

      expect(merged, hasLength(1));
      expect(merged.single.episodes, 24);
      expect(merged.single.description, '简介来自网页版');
    });

    test('同 id 但剧名不同时不合并（防撞号）', () {
      final merged = SourceDedupe.apply([
        drama(source: 'a', seriesId: '1234567', title: '归路'),
        drama(source: 'b', seriesId: '1234567', title: '完全不同的剧名'),
      ]);

      expect(merged, hasLength(2));
    });

    test('标点与空白差异视为同一部剧', () {
      final merged = SourceDedupe.apply([
        drama(source: 'a', seriesId: 'abc', title: '霸道总裁爱上我'),
        drama(source: 'b', seriesId: 'xyz', title: '霸道总裁爱上我！'),
      ]);

      expect(merged, hasLength(1));
    });

    test('季号后缀不被包含匹配误并', () {
      final merged = SourceDedupe.apply([
        drama(source: 'a', seriesId: '9999999', title: '归路', episodes: 78),
        drama(source: 'b', seriesId: '9999999', title: '归路 第二季', episodes: 60),
      ]);

      expect(merged, hasLength(2));
    });

    test('非数字 id 退化为「标题 + 集数」作为身份键', () {
      final merged = SourceDedupe.apply([
        drama(source: 'a', seriesId: 'abc', title: '小城故事', episodes: 30),
        drama(source: 'b', seriesId: 'def', title: '小城故事', episodes: 30),
        drama(source: 'c', seriesId: 'ghi', title: '小城故事', episodes: 12),
      ]);

      expect(merged, hasLength(2));
    });

    test('重复项保留首次出现的位置', () {
      final merged = SourceDedupe.apply([
        drama(source: 'a', seriesId: '1', title: '第一'),
        drama(source: 'b', seriesId: '2', title: '第二'),
        drama(source: 'a', seriesId: '1', title: '第一'),
      ]);

      expect(merged.map((e) => e.title).toList(), ['第一', '第二']);
    });
  });
}
