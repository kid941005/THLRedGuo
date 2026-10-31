/// 站源互备关系表。
///
/// 主源取流失败（无片源 / 未导入 APK / 网关风控）时，引擎按此表回退到备份源播同一集。
/// 新增互补源时只改这里，不必改 `dart_core_engine.dart`。
///
/// 当前语义：
/// - `hongguo`（官方 App 接口）↔ `hongguo-web`（官网 360P 试看）：互为备份；
/// - `hongguo-gw`（自建 Docker 网关）→ `hongguo-web`：网关被上游风控时降级到官网试看。
///
/// 注意：只做一跳回退，不递归，避免 A→B→A 死循环。
const Map<String, String> kSourceCompanions = <String, String>{
  'hongguo': 'hongguo-web',
  'hongguo-web': 'hongguo',
  'hongguo-gw': 'hongguo-web',
};

/// 返回 [source] 的备份源 id；没有配置则返回 null。
String? companionSourceOf(String source) {
  final companion = kSourceCompanions[source];
  if (companion == null || companion.isEmpty || companion == source) {
    return null;
  }
  return companion;
}
