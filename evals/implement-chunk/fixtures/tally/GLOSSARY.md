# tally

Tally converts lengths between units for customers who cut, ship, and price material by length.

## Language

**Length**:
The size of something a customer measures, end to end. A length is never below zero.
_Avoid_: distance, displacement

**Unit**:
A named length that other lengths are counted in, such as the kilometre.
_Avoid_: measure

**Symbol**:
The short name that identifies a unit in requests, responses, and data, written exactly as listed: `km`, never `KM`.
_Avoid_: abbreviation, abbr, unit code

**Factor**:
The number of metres in one unit.
_Avoid_: rate, ratio

**Conversion**:
A length given in one unit, expressed in another.
_Avoid_: translation, transform

**Precision**:
How finely a converted length is rounded, counted after the decimal point: precision 2 turns 6.2137 into 6.21.
_Avoid_: decimals, decimal places, places, digits, dp
