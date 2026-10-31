import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

class HongguoPlaybackProfile {
  static const _channel = MethodChannel('duanju/device');
  static int _revision = 0;
  static Map<String, dynamic>? _runtime;
  static Future<Map<String, dynamic>?>? _loading;
  static String _summary = '尚未读取';
  static bool _imported = false;

  static bool get supported =>
      !kIsWeb && defaultTargetPlatform == TargetPlatform.iOS;
  static int get revision => _revision;
  static String get diagnosticSummary => _summary;

  /// 本机是否已导入可用的播放配置（同步读缓存，供同步逻辑判断）。
  ///
  /// 由 [metadata] / [runtimeConfiguration] / [importApk] 的返回刷新；
  /// 应用刚启动、还没调用过上述方法时为 false —— 保守取值，
  /// 宁可先按「未导入」处理，也不要误以为官方源可播。
  static bool get imported => _imported;

  static void _recordMetadata(Map<String, dynamic>? value) {
    _imported = value?['imported'] == true;
    final version = value?['appVersion'];
    _summary =
        value?['imported'] == true &&
            version is String &&
            RegExp(r'^[0-9.]{1,32}$').hasMatch(version)
        ? '已导入红果 $version · 仅本机存储'
        : '未导入';
  }

  static Future<Map<String, dynamic>> metadata() async {
    if (!supported) return {'supported': false, 'imported': false};
    final value = await _channel.invokeMapMethod<String, dynamic>(
      'hongguoPlaybackProfileMetadata',
    );
    _recordMetadata(value);
    return {'supported': true, ...?value};
  }

  static Future<Map<String, dynamic>?> runtimeConfiguration() async {
    if (!supported) return null;
    if (_runtime != null) return Map.of(_runtime!);
    final pending = _loading;
    if (pending != null) return pending;
    final revision = _revision;
    final future = () async {
      final value = await _channel.invokeMapMethod<String, dynamic>(
        'hongguoPlaybackProfileRuntime',
      );
      if (revision != _revision) return runtimeConfiguration();
      if (value?['configuration'] is! String) {
        _recordMetadata(value);
        return null;
      }
      _runtime = Map<String, dynamic>.of(value!);
      _recordMetadata({'imported': true, 'appVersion': value['appVersion']});
      return Map<String, dynamic>.of(value);
    }();
    _loading = future;
    try {
      return await future;
    } catch (error) {
      if (revision != _revision) return runtimeConfiguration();
      _summary =
          error is PlatformException && error.code == 'LOCAL_PROFILE_INVALID'
          ? '配置无效，请重新导入'
          : '暂不可访问';
      rethrow;
    } finally {
      if (identical(_loading, future)) _loading = null;
    }
  }

  static Future<Map<String, dynamic>> importApk(String path) async {
    final value = await _channel.invokeMapMethod<String, dynamic>(
      'importHongguoPlaybackApk',
      {'path': path},
    );
    _invalidate();
    _recordMetadata(value);
    return Map<String, dynamic>.of(value ?? {'imported': false});
  }

  static Future<void> remove() async {
    await _channel.invokeMethod<void>('removeHongguoPlaybackProfile');
    _invalidate();
    _summary = '未导入';
    _imported = false;
  }

  static void _invalidate() {
    _revision++;
    _runtime = null;
    _loading = null;
  }
}
