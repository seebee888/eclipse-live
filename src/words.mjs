// 256 short, friendly words for client passwords: four of them and a number, like the first clients' passwords.
// 4 × 8 bits + 90 numbers ≈ 38 bits, behind 600k rounds of PBKDF2 per guess.
export const WORDS = `
acorn amber anchor apple arrow aspen atlas autumn badge bagel bamboo banjo barley basil beacon bear berry birch
biscuit blaze bloom blue bonfire boulder breeze brick bridge brook bubble cabin cactus camel candle canoe canyon
caramel cargo carrot castle cedar cello chalk cherry chess cider cinema cliff clover cobalt comet compass copper
coral cotton cougar crane crayon cricket crown crystal cumin daisy delta denim desert dolphin domino dragon drum
dune eagle echo ember emerald falcon fern fiddle fig finch fjord flame flint forest fossil fox galaxy garden
garnet gecko ginger glacier globe goose granite grape gravy guitar harbor harvest hazel heron hickory honey
horizon hummus igloo indigo iris island ivory jade jaguar jasmine jelly jungle kayak kettle kiwi koala lagoon
lantern lava lemon lilac lily lime lion lotus lunar magnet mango maple marble meadow melon meteor mint mocha
monsoon moose mosaic muffin nectar nickel noodle nova nutmeg oasis ocean olive onyx orbit orchid otter owl
paddle panda papaya parrot peach pebble pecan pepper piano pickle pilot pine pixel plum polar pony poppy prairie
prism pumpkin quartz quill rabbit radar rain raven reef ribbon river robin rocket rose ruby saffron sage salmon
sapphire satin sequoia shadow shell sierra silver sky sloth snow sonic spark sparrow spruce squid star stone
storm sugar summit sun sunset swan tango teal thunder tiger timber toast topaz tulip tundra turtle velvet violet
walnut waffle walrus willow wind winter wolf zebra zephyr zinc acrobat almond apricot avocado beetle blossom
bongo breadth button cashew cobra cocoa cookie cosmos dahlia dingo falafel feather flamingo frost
`.trim().split(/\s+/);
