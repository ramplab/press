class Order
  attr_reader :items

  def initialize(items)
    @items = items
  end

  def total_cents
    items.sum { |item| item[:price_cents] }
  end

  def empty?
    items.empty?
  end
end
