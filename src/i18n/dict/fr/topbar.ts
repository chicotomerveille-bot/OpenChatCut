// FR dictionary (field fragmentation, key = Chinese original text).
// A key absent from this file is served from the English dictionary instead of
// the Chinese original (see fetchDicts('fr') in dictRegistry.ts), so French can
// ship screen by screen without ever showing Chinese to a French user.
export default {
  '切换界面语言': "Changer la langue de l'interface",
  '返回工程列表': 'Retour aux projets',
  '双击重命名': 'Double-cliquez pour renommer',
  '编辑快捷键': 'Modifier les raccourcis clavier',
  '撤销': 'Annuler',
  '重做': 'Rétablir',
  '设计风格(品牌)': 'Style de design (marque)',
  '历史版本': 'Historique des versions',
  '切换面板布局': 'Basculer la disposition des panneaux',
  '导出 MP4': 'Exporter en MP4',
  '导出中…': 'Exportation…',
  '导出': 'Exporter',
  '账户': 'Compte',
  '窗口控制': 'Contrôles de la fenêtre',
  '关闭窗口': 'Fermer la fenêtre',
  '最小化窗口': 'Réduire la fenêtre',
  '缩放窗口': 'Agrandir la fenêtre',
} as Record<string, string>;
