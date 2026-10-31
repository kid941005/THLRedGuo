import 'package:THLRedLook/core/js/hongguo_playback_profile.dart';
import 'package:THLRedLook/models/catalog/models.dart';

/// 跨源去重：同一部剧被多个数据源返回时只保留一条。
///
/// 规则：
///  - 身份键优先用原始剧集 id（红果的 19 位 series_id），否则退回「标题 + 集数」；
///  - 标题归一化后必须完全一致才合并，避免不同源的 id 撞号误合并；
///  - 保留优先级由 [rank] 决定，官方 App 接口源（hongguo）优先于网页降级源；
///  - 合并时用另一条补齐缺失字段，集数取较大值。
class SourceDedupe {
  /// 源优先级：数字越小越优先。
  /// 官方 App 接口源在 iOS 上依赖「本机导入的播放配置」，未导入时不可播；
  /// 只有这一种情况让网页版（360p 试看）优先，其余一律官方源优先（全集高清）。
  static int rank(String source) {
    final webFirst =
        HongguoPlaybackProfile.supported && !HongguoPlaybackProfile.imported;
    if (source == 'hongguo') return webFirst ? 20 : 0;
    if (source == 'hongguo-web') return 10;
    return 30;
  }

  static String _titleKey(String value) => value
      .toLowerCase()
      .replaceAll(RegExp(r'[\s\-—_·。，,：:!！?？()（）\[\]【】]'), '');

  static bool sameTitle(String a, String b) {
    final ka = _titleKey(a);
    final kb = _titleKey(b);
    if (ka.isEmpty || kb.isEmpty) return ka == kb;
    // 只认同「归一化后完全相等」，不做包含匹配：
    // 否则「归路」会与「归路 第二季」被误判为同一部剧。
    return ka == kb;
  }

  static String keyOf(Drama drama) {
    final raw = drama.cleanSourceId.trim();
    if (raw.length >= 6 && RegExp(r'^\d+$').hasMatch(raw)) return 'id:$raw';
    final titleKey = _titleKey(drama.title);
    // 标题为空（或全是标点）时不能退化成「空标题+集数」：
    // 那样所有无题条目会撞到同一个键，被误合成一条
    if (titleKey.isEmpty) return 'id:${drama.id}';
    return 'title:$titleKey|${drama.episodes}';
  }

  static Drama combine(Drama keep, Drama other) {
    if (identical(keep, other)) return keep;
    return Drama(
      id: keep.id,
      source: keep.source,
      sourceId: keep.sourceId,
      title: keep.title.isEmpty || keep.title == '短剧'
          ? other.title
          : keep.title,
      description: keep.description.isEmpty
          ? other.description
          : keep.description,
      cover: keep.cover.isEmpty ? other.cover : keep.cover,
      episodes: keep.episodes >= other.episodes
          ? keep.episodes
          : other.episodes,
      category: keep.category.isEmpty ? other.category : keep.category,
      vip: keep.vipStatus ?? other.vipStatus,
      heat: keep.heat.isEmpty ? other.heat : keep.heat,
      views: keep.views.isEmpty ? other.views : keep.views,
      onlineDate: keep.onlineDate.isEmpty ? other.onlineDate : keep.onlineDate,
      tags: keep.tags.isNotEmpty ? keep.tags : other.tags,
      releaseStatus: keep.releaseStatus.isEmpty
          ? other.releaseStatus
          : keep.releaseStatus,
    );
  }

  /// 按出现顺序去重，重复项保留首次出现的位置。
  static List<Drama> apply(Iterable<Drama> items) {
    final merged = <String, Drama>{};
    for (final item in items) {
      final key = keyOf(item);
      final existing = merged[key];
      if (existing == null) {
        merged[key] = item;
        continue;
      }
      if (!sameTitle(existing.title, item.title)) {
        merged['$key#${item.id}'] = item;
        continue;
      }
      merged[key] = rank(existing.source) <= rank(item.source)
          ? combine(existing, item)
          : combine(item, existing);
    }
    return merged.values.toList();
  }
}
