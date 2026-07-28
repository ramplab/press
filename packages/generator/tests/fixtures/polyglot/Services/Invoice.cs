namespace Fixture.Services;

public sealed class Invoice
{
    public decimal Subtotal { get; init; }

    public decimal TotalWithTax(decimal rate)
    {
        return Subtotal * (1m + rate);
    }
}
