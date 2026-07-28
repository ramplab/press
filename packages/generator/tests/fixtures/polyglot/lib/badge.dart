class Badge {
  const Badge(this.label);

  final String label;

  String render() => '[$label]';
}

Badge makeBadge(String label) => Badge(label.trim());
