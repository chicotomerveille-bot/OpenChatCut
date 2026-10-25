// FR dictionary (field fragmentation, key = Chinese original text).
// Source: src/editor/types.ts UI labels (ZOOM_SHAPE_LABELS, TRANSITION_LABELS) and
// the user-facing editor errors. The constant bodies stay Chinese; the UI calls t(label).
export default {
  // ZOOM_SHAPE_LABELS
  '冲击': 'Impact',
  '推进拉回': 'Avance et retour',
  '慢推': 'Travelling avant lent',
  '瞬时': 'Instantané',
  '拉远': 'Dézoom',
  '缓入推近': 'Avance en douceur',
  '弹性推近': 'Avance élastique',
  '快切推近': 'Avance sèche',
  '心跳脉冲': 'Pulsation',
  '甩入推近': 'Avance au fouet',
  // TRANSITION_LABELS
  '推进转场': "Zoom d'anticipation",
  '白色划线转场': 'Balayage ligne nette',
  '叠化转场': 'Fondu enchaîné',
  '闪黑转场': 'Fondu au noir',
  '闪白转场': 'Flash blanc',
  '冲击抖动转场': "Secousse d'impact",
  '叠加转场': 'Mélange de luminance',
  '光溶转场': 'Fondu organique',
  '翻页转场': 'Page tournée',
  '焦点转场': 'Changement de point',
  '柔化擦除转场': 'Balayage doux',
  '甩镜转场': 'Filé latéral',
  '圆形擦除转场': 'Balayage circulaire',
  '人声分离失败，未修改任何片段。': "La séparation des voix a échoué ; aucun clip n'a été modifié.",
  '响度分析失败，未修改任何片段。': "L'analyse de loudness a échoué ; aucun clip n'a été modifié.",
  '所选片段的源素材已变化，旧的人声分离结果已丢弃。请重试。': 'Le média source des clips sélectionnés a changé ; l\'ancien résultat de séparation des voix a été abandonné. Réessayez.',
} as Record<string, string>;
